# Examples

All examples consume the built package from `dist/`.

```
# from repo root
bun install
bun run build

cd examples/<name>
bun install
bun run dev
```

This ensures:

- `dist/` exists
- Examples fail fast if exports are broken