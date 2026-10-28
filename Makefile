.PHONY: build test race vet benchmark plugin-test plugin-config opencode-test recovery-test dashboard-install dashboard-build dashboard-test

build:
	go build -trimpath -o bin/deltarelay ./cmd/deltarelay

test:
	go test ./...

race:
	go test -race ./...

vet:
	go vet ./...

benchmark:
	go test ./internal/chunker -run '^$$' -bench BenchmarkSplit -benchmem

plugin-test:
	node --test integration/opencode/*.test.mjs

plugin-config:
	node integration/opencode/config.mjs

recovery-test:
	python3 -B -m unittest discover -s deploy -p 'test_*.py'

opencode-test:
	DELTARELAY_TEST_OPENCODE=1 go test -v ./internal/gateway -run TestInstalledOpenCodePlugin -count=1

dashboard-install:
	pnpm install --offline --frozen-lockfile --trust-lockfile

dashboard-build:
	pnpm build

dashboard-test:
	pnpm check
	pnpm test
