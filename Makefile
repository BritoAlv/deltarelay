.PHONY: build test race vet benchmark baseline-benchmark plugin-test plugin-config opencode-test recovery-test dashboard-install dashboard-build dashboard-test dashboard-browser-test verify

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

baseline-benchmark:
	go test ./internal/server -run '^$$' -bench '^BenchmarkGatewayRequestStartup$$' -benchtime=50x -count=3 -cpu=2 -benchmem

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

dashboard-browser-test:
	pnpm test:browser

# Full offline matrix. Requires Go, Node, Python, and the documented pnpm
# offline store; never uses real accounts, private profiles, or live services.
# Optional installed-OpenCode (make opencode-test) and performance
# (make baseline-benchmark) checks stay separate.
verify:
	$(MAKE) build
	$(MAKE) race
	$(MAKE) vet
	$(MAKE) plugin-test
	DELTARELAY_RECOVERY_TEST_BINARY="$(CURDIR)/bin/deltarelay" $(MAKE) recovery-test
	$(MAKE) dashboard-install
	$(MAKE) dashboard-build
	$(MAKE) dashboard-test
	$(MAKE) dashboard-browser-test
	git diff --check
