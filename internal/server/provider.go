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
// remain stable so persisted request claims cannot change meaning.
func requestFingerprint(input protocol.ForwardRequest) string {
	fingerprint, _ := json.Marshal(struct {
		Target  string
		Headers http.Header
		Hash    string
		Size    int64
	}{input.Target, input.Headers, input.Manifest.Hash, input.Manifest.Size})
	return protocol.Sum(fingerprint)
}

// prepareProviderRequest validates and normalizes provider metadata before
// computing the durable dispatch fingerprint.
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

func (s *Server) providerValidationError(w http.ResponseWriter, err error) {
	var failure *providerValidationError
	if !errors.As(err, &failure) {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	switch failure.kind {
	case providerInvalidManifest:
		writeError(w, http.StatusBadRequest, failure.cause.Error())
	case providerInvalidHeaders:
		writeError(w, http.StatusBadRequest, "invalid provider headers")
	case providerDisallowedTarget:
		writeError(w, http.StatusForbidden, "upstream URL is not allowlisted")
	case providerEncodedBody:
		writeError(w, http.StatusBadRequest, "decoded provider content required")
	}
}

func validProviderEnvelope(input protocol.ForwardRequest, pathID string) bool {
	if input.Version != protocol.RelayVersion || input.Method != http.MethodPost || !protocol.ValidRequestID(input.ID) {
		return false
	}
	return input.ID == pathID
}
