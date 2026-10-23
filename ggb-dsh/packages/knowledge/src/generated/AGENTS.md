# Generated Manual data: read by search

`official-manual-index.ts` contains generated command cards, not hand-maintained implementation.
Do not read the entire file into agent context. Search for the relevant command or signature,
then read only the matching cards. From the `ggb-dsh` workspace:

```sh
rg -n -F -A 18 '"command": "Focus"' packages/knowledge/src/generated/official-manual-index.ts
```

Use a narrower signature or bounded line range if the command has many overloads.
For generation changes, inspect `tools/build-ggb-manual-index.mjs`.
For retrieval behavior, inspect `packages/knowledge/src/manual-lookup.ts` and its tests.
Do not edit the generated index by hand. Regenerate only when the task needs a data change.
