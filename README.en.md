# cocos-npm-publisher

[中文](./README.md) | **English**

Cocos Creator extension plugin publish manager — automatically scans the extensions in your project, selects the registry based on each extension directory's `.npmrc`, and executes `npm publish`.

## Features

- **Auto-scan Extensions**: Automatically scans all extensions under the project's `extensions/` directory that contain both `.npmrc` and `package.json`
- **Version Management**: One-click semantic version bumping — Patch / Minor / Major
- **Release Notes**: Write release notes before publishing; they are automatically saved to the `releaseNote` field in `package.json`
- **NPM Login**: When no authentication credentials are detected in an extension's `.npmrc`, provides a username/password login form that writes the auth config automatically
- **npmrc Normalization**: Automatically fixes the `always-auth` setting in `.npmrc` before publishing for compatibility with npm v9+
- **Failure Rollback**: If publishing fails, `package.json` is automatically rolled back to its pre-publish state
- **Real-time Logs**: A built-in Console area at the bottom of the panel streams live log output during the publish process

## Prerequisites

Each extension directory that needs to be published must contain:

1. **`package.json`** — standard npm package descriptor
2. **`.npmrc`** — must include `registry=<your npm registry URL>`, which the plugin uses to determine the publish target

```
extensions/
├── my-extension-a/
│   ├── package.json
│   └── .npmrc          ← registry=https://registry.npmjs.org/
├── my-extension-b/
│   ├── package.json
│   └── .npmrc          ← registry=https://your-private-registry.com/
```

## Installation

Place the `cocos-npm-publisher` directory inside the `extensions/` folder of your Cocos Creator project.

## Usage

1. In the Cocos Creator menu bar, click **Extensions → NPM Extension Manager → Open Publish Panel**
2. The plugin automatically scans `extensions/` for publishable packages and displays them as cards
3. Each card shows the extension name, current version, description, registry URL, and authentication status
4. Select a version bump type (Patch / Minor / Major) or manually enter a target version number
5. Fill in release notes (optional)
6. If not authenticated, complete authentication by entering your username and password in the login form
7. Click the **Publish** button — the plugin will update `package.json` and run `npm publish --access public`


## License

This project is licensed under the [MIT License](./LICENSE).