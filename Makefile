.PHONY: test build

test:
	cd contracts && forge test -vv

build:
	cd contracts && forge build
