package server

import (
	"encoding/json"
	"errors"
	"net/http"

	"deltarelay/internal/protocol"
	"deltarelay/internal/upstream"
)

type providerValidationKind int

const (
	providerInvalidManifest providerValidationKind = iota
	providerInvalidHeaders
	providerDisallowedTarget
	providerEncodedBody
)

type providerValidationError struct {
	kind  providerValidationKind
	cause error
}

func (e *providerValidationError) Error() string { return e.cause.Error() }
func (e *providerValidationError) Unwrap() error { return e.cause }

// requestFingerprint freezes the persisted claim representation. Field names,
// order, JSON escaping, cleaned headers, and exclusion of IDs/chunk layout must
// remain compatible with claims written by both APIs.
func requestFingerprint(input protocol.ForwardRequest) string {
	fingerprint, _ := json.Marshal(struct {
		Target  string
		Headers http.Header
		Hash    string
		Size    int64
	}{input.Target, input.Headers, input.Manifest.Hash, input.Manifest.Size})
	return protocol.Sum(fingerprint)
}

// prepareProviderRequest is the common validation, normalization, and claim
// fingerprint step shared by legacy streaming and durable submission. Version,
// request-ID, and path-ID rules stay with each endpoint because their messages
// differ, but accepted IDs are identical.
func prepareProviderRequest(policy *upstream.Policy, maxBodySize int64, input protocol.ForwardRequest) (protocol.ForwardRequest, string, error) {
	if err := input.Manifest.Validate(maxBodySize, protocol.DefaultMaxChunks); err != nil {
		return input, "", &providerValidationError{kind: providerInvalidManifest, cause: err}
	}
	if err := upstream.ValidateHeaders(input.Headers); err != nil {
		return input, "", &providerValidationError{kind: providerInvalidHeaders, cause: err}
	}
	if _, err := policy.Match(input.Target); err != nil {
		return input, "", &providerValidationError{kind: providerDisallowedTarget, cause: err}
	}
	input.Headers = upstream.CleanHeaders(input.Headers)
	if encoding := input.Headers.Get("Content-Encoding"); encoding != "" && encoding != "identity" {
		return input, "", &providerValidationError{kind: providerEncodedBody, cause: errors.New("decoded provider content required")}
	}
	input.Headers.Del("Content-Encoding")
	return input, requestFingerprint(input), nil
}

// providerValidationError maps the shared validation kinds back to each
// endpoint's intentional status codes and messages.
func (s *Server) providerValidationError(w http.ResponseWriter, err error, legacy bool) {
	var failure *providerValidationError
	if !errors.As(err, &failure) {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	switch failure.kind {
	case providerInvalidManifest:
		writeError(w, http.StatusBadRequest, failure.cause.Error())
	case providerInvalidHeaders:
		if legacy {
			writeError(w, http.StatusBadRequest, failure.cause.Error())
		} else {
			writeError(w, http.StatusBadRequest, "invalid provider headers")
		}
	case providerDisallowedTarget:
		if legacy {
			writeError(w, http.StatusForbidden, failure.cause.Error())
		} else {
			writeError(w, http.StatusForbidden, "upstream URL is not allowlisted")
		}
	case providerEncodedBody:
		if legacy {
			writeError(w, http.StatusBadRequest, "forwarding requires decoded content")
		} else {
			writeError(w, http.StatusBadRequest, "decoded provider content required")
		}
	}
}

func validProviderEnvelope(input protocol.ForwardRequest, version int, pathID string) bool {
	if input.Version != version || input.Method != http.MethodPost || !protocol.ValidRequestID(input.ID) {
		return false
	}
	return pathID == "" || input.ID == pathID
}
