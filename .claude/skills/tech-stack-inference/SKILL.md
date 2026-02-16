---
description: Detect the project's technology stack, package manager, and testing framework automatically. Run at the start of every session.
---

# Tech Stack Inference

Use this skill at the start of every session to ground the agent in the reality of the current project.

## Routine: detect_environment

### 1. File Scan
Check for these files in the project root:
- `wxt.config.ts` → WXT Chrome Extension project
- `package.json` → Node.js (check for WXT, React, Vue)
- `tsconfig.json` → TypeScript enabled
- `manifest.json` → Raw Chrome Extension (no framework)
- `pyproject.toml`, `requirements.txt` → Python
- `Cargo.toml` → Rust

### 2. WXT-Specific Detection
If `wxt.config.ts` exists:
- Check `entrypoints/` directory structure
- Identify UI framework from dependencies (React, Vue, Svelte, Solid)
- Check for `entrypoints/offscreen/` (Offscreen Document pattern)
- Check for `entrypoints/background.ts` (Service Worker)

### 3. Command Inference
- **WXT project:** `npm run dev` (dev), `npm run build` (build), `npm run typecheck` (type check)
- **Test runner:** Check for `vitest`, `jest`, or `playwright` in devDependencies
- **Linter:** Check for `eslint` config files or `lint` script in package.json
- **Formatter:** Check for `prettier` config

### 4. Output Generation
Generate a summary block:

```json
{
  "language": "TypeScript",
  "framework": "WXT",
  "ui_framework": "React|Vue|None",
  "extension_type": "Manifest V3",
  "package_manager": "npm|pnpm|yarn",
  "dev_command": "npm run dev",
  "build_command": "npm run build",
  "test_command": "npm test|npx vitest",
  "typecheck_command": "npm run typecheck",
  "lint_command": "npm run lint",
  "has_offscreen": true|false,
  "has_content_script": true|false,
  "has_popup": true|false
}
```

### 5. Communicate to Subagents
Once detected, the Lead Orchestrator must include this info in every subagent task prompt. Example: "This is a WXT/TypeScript/React project. Use `npm run typecheck` for verification and `npm run lint` for linting. Offscreen Document pattern is in use."
