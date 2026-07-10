# Contributing

Hey, thanks for wanting to contribute! Here's what you need to know.

## Setup

```bash
git clone https://github.com/K4ryuu/steam-workshop-ts.git
cd steam-workshop-ts
bun install   # or pnpm/npm, whatever you prefer
```

## Running tests

```bash
bun test          # run all tests
bun test --coverage  # run with coverage report
```

All unit tests should pass.

## Code style

- TypeScript, strict mode, no `any` (any explicitly typed as any will fail the lint check)
- No runtime dependencies - keep it that way
- JSDoc on all public methods, params, returns, throws - short and casual, no corporate fluff
- Short inline comments for non-obvious logic
- Follow the patterns already in the codebase

## Commits

```
type: description
```

Types: `feat` `fix` `docs` `chore` `refactor` `test`

Keep it lowercase, keep it short.

## Pull requests

- One thing per PR
- If it's a new feature, write unit tests for it
- If it's a bug fix, add a test that catches it
- Update `CHANGELOG.md` - add a new version section or note it under the latest version

That's it. Don't overthink it.
