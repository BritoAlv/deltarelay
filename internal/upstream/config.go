package upstream

import (
	"encoding/json"
	"errors"
	"io"
	"os"
)

func Load(path string) ([]Rule, error) {
	if path == "" {
		return nil, nil
	}
	f, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	defer f.Close()
	info, err := f.Stat()
	if err != nil {
		return nil, err
	}
	if !info.Mode().IsRegular() || info.Size() > 1<<20 {
		return nil, errors.New("upstream configuration must be a regular file no larger than 1 MiB")
	}
	decoder := json.NewDecoder(io.LimitReader(f, (1<<20)+1))
	decoder.DisallowUnknownFields()
	var rules []Rule
	if err := decoder.Decode(&rules); err != nil {
		return nil, err
	}
	var extra any
	if decoder.Decode(&extra) != io.EOF || len(rules) > 128 {
		return nil, errors.New("invalid or oversized upstream configuration")
	}
	return rules, nil
}
