# Same targets as CI; Prettier runs through npx so nothing is installed into the repo.
PRETTIER := npx --yes prettier@3.9.6
SCRIPTS := $(wildcard skills/*/scripts/*.mjs)

.PHONY: all check test fmt fmt-check

all: check test fmt-check

check:
	@for f in $(SCRIPTS); do node --check "$$f" || exit 1; done

test:
	node --test tests/

fmt:
	$(PRETTIER) --write .

fmt-check:
	$(PRETTIER) --check .
