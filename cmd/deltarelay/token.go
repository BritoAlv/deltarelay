package main

import (
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"os"
	"strings"

	"deltarelay/internal/fsx"
)

// readToken applies the documented precedence: a non-empty explicit token-file
// path replaces the environment value, and an invalid explicit file fails
// closed instead of falling back. Environment values are not trimmed.
func readToken(path, environment string) (string, error) {
	token := os.Getenv(environment)
	if path != "" {
		info, err := os.Stat(path)
		if err != nil {
			return "", err
		}
		if !info.Mode().IsRegular() || info.Size() > 4096 || info.Mode().Perm()&0077 != 0 {
			return "", errors.New("token file must be regular, small, and accessible only to its owner (chmod 600)")
		}
		data, err := os.ReadFile(path)
		if err != nil {
			return "", err
		}
		token = strings.TrimSpace(string(data))
	}
	if token == "" || len(token) > 4096 || strings.ContainsAny(token, "\r\n") {
		return "", fmt.Errorf("set %s or supply a private token file", environment)
	}
	return token, nil
}

func tokenCommand(args []string, stdout, stderr io.Writer) error {
	flags := flag.NewFlagSet("gen-token", flag.ContinueOnError)
	flags.SetOutput(stderr)
	output := flags.String("output", "", "new token file, mode 600; never overwrites existing files")
	if err := flags.Parse(args); err != nil {
		if errors.Is(err, flag.ErrHelp) {
			return nil
		}
		return err
	}
	if *output == "" || flags.NArg() != 0 {
		return errors.New("gen-token requires --output; create the private parent directory first")
	}
	var secret [32]byte
	if _, err := rand.Read(secret[:]); err != nil {
		return err
	}
	_, err := fsx.CreateExclusive(*output, 0600, func(f *os.File) error {
		_, err := fmt.Fprintln(f, hex.EncodeToString(secret[:]))
		return err
	})
	if err != nil {
		return err
	}
	return json.NewEncoder(stdout).Encode(map[string]string{"token_file": *output})
}
