// Package chunker implements deterministic content-defined chunking.
package chunker

import (
	"errors"
	"io"

	"deltarelay/internal/protocol"
)

const (
	DefaultMin = 4 << 10
	DefaultAvg = 16 << 10
	DefaultMax = 64 << 10
)

type Config struct {
	Min int
	Avg int
	Max int
}

func DefaultConfig() Config {
	return Config{Min: DefaultMin, Avg: DefaultAvg, Max: DefaultMax}
}

func (c Config) Validate() error {
	if c.Min <= 0 || c.Avg < c.Min || c.Max < c.Avg || c.Max > protocol.MaxChunkSize {
		return errors.New("chunk sizes must satisfy 0 < min <= avg <= max <= 1 MiB")
	}
	if c.Avg&(c.Avg-1) != 0 {
		return errors.New("average chunk size must be a power of two")
	}
	return nil
}

// A fixed, generated gear table makes boundaries reproducible across machines
// and process restarts. The rolling fingerprint resynchronizes after insertions;
// chunk identity itself always uses cryptographic SHA-256, not this fingerprint.
var gear = func() [256]uint64 {
	var table [256]uint64
	x := uint64(0x243f6a8885a308d3)
	for i := range table {
		x += 0x9e3779b97f4a7c15
		z := x
		z = (z ^ (z >> 30)) * 0xbf58476d1ce4e5b9
		z = (z ^ (z >> 27)) * 0x94d049bb133111eb
		table[i] = z ^ (z >> 31)
	}
	return table
}()

// Split reads in bounded memory. The callback must consume or copy data before
// returning: its backing buffer is reused for the next chunk.
func Split(r io.Reader, config Config, emit func([]byte) error) error {
	if err := config.Validate(); err != nil {
		return err
	}
	buffer := make([]byte, 64<<10)
	chunk := make([]byte, 0, config.Max)
	var fingerprint uint64
	mask := uint64(config.Avg - 1)
	emptyReads := 0
	for {
		n, err := r.Read(buffer)
		if n == 0 && err == nil {
			emptyReads++
			if emptyReads >= 100 {
				return io.ErrNoProgress
			}
		} else {
			emptyReads = 0
		}
		for _, value := range buffer[:n] {
			chunk = append(chunk, value)
			fingerprint = (fingerprint << 1) + gear[value]
			if len(chunk) >= config.Max || (len(chunk) >= config.Min && fingerprint&mask == 0) {
				if emitErr := emit(chunk); emitErr != nil {
					return emitErr
				}
				chunk = chunk[:0]
				fingerprint = 0
			}
		}
		if err != nil {
			if err != io.EOF {
				return err
			}
			if len(chunk) > 0 {
				return emit(chunk)
			}
			return nil
		}
	}
}
