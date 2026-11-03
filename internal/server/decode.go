package server

import (
	"bytes"
	"compress/gzip"
	"encoding/json"
	"errors"
	"io"
	"net/http"
)

type decodeIssue int

const (
	decodeOK decodeIssue = iota
	decodeEncoding
	decodeTooLarge
	decodeSyntax
	decodeTrailing
)

// decodeBoundedJSON applies the shared compression, wire-size, decoded-size, and
// single-object rules. Callers keep their endpoint-specific content types,
// status codes, and messages.
func decodeBoundedJSON(w http.ResponseWriter, r *http.Request, limit int64, result any) decodeIssue {
	reader, closeBody, err := decodedBody(w, r, limit)
	if err != nil {
		return decodeEncoding
	}
	defer closeBody()
	data, err := io.ReadAll(reader)
	if err != nil || int64(len(data)) > limit {
		return decodeTooLarge
	}
	decoder := json.NewDecoder(bytes.NewReader(data))
	decoder.DisallowUnknownFields()
	if decoder.Decode(result) != nil {
		return decodeSyntax
	}
	var extra any
	if decoder.Decode(&extra) != io.EOF {
		return decodeTrailing
	}
	return decodeOK
}

func decodeJSON(w http.ResponseWriter, r *http.Request, limit int64, result any) bool {
	if r.Header.Get("Content-Type") != "application/json" {
		writeError(w, 415, "application/json required")
		return false
	}
	switch decodeBoundedJSON(w, r, limit, result) {
	case decodeEncoding:
		writeError(w, 400, "invalid content encoding")
		return false
	case decodeTooLarge:
		writeError(w, 400, "invalid or oversized JSON body")
		return false
	case decodeSyntax, decodeTrailing:
		writeError(w, 400, "expected one valid JSON object")
		return false
	}
	return true
}

// Both the compressed wire body and the decoded body are bounded. The extra
// decoded byte lets callers distinguish an exact limit from silent truncation.
func decodedBody(w http.ResponseWriter, r *http.Request, maxDecoded int64) (io.Reader, func(), error) {
	r.Body = http.MaxBytesReader(w, r.Body, maxDecoded+(64<<10))
	var reader io.Reader = r.Body
	closeBody := func() { _ = r.Body.Close() }
	switch r.Header.Get("Content-Encoding") {
	case "", "identity":
	case "gzip":
		gz, err := gzip.NewReader(r.Body)
		if err != nil {
			closeBody()
			return nil, func() {}, err
		}
		reader = gz
		closeBody = func() { _ = gz.Close(); _ = r.Body.Close() }
	default:
		closeBody()
		return nil, func() {}, errors.New("unsupported content encoding")
	}
	return io.LimitReader(reader, maxDecoded+1), closeBody, nil
}
