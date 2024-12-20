# Convex ProseMirror Component

[![npm version](https://badge.fury.io/js/@convex-dev%2Fprosemirror-sync.svg)](https://badge.fury.io/js/@convex-dev%2Fprosemirror-sync)

This is a [Convex Component](https://convex.dev/components) that syncs a
[ProseMirror](https://prosemirror.net/) document between clients via a
[Tiptap](https://tiptap.dev/) extension.

<!-- START: Include on https://convex.dev/components -->

Add a collaborative editor that syncs to the cloud. With this component, users
can edit the same document in multiple tabs or devices, and the changes will be
synced to the cloud. The data lives in your Convex database, and can be stored
alongside the rest of your app's data.

Just configure your editor features, add this component to your Convex backend,
and use the `useTiptapSync` React hook.
Read this [Stack post](https://stack.convex.dev/add-a-collaborative-document-editor-to-your-app) for more details.

[![Example of editing](http://img.youtube.com/vi/TGd-Nl7PBYQ/0.jpg)](http://www.youtube.com/watch?v=TGd-Nl7PBYQ "Collaborative editing syncing")

Example usage, see [below](#usage) for more details:

```tsx
function CollaborativeEditor() {
  const sync = useTiptapSync(api.prosemirrorSync, "some-id");
  return sync.isLoading ? (
    <p>Loading...</p>
  ) : sync.initialContent !== null ? (
    <EditorProvider
      content={sync.initialContent}
      extensions={[...extensions, sync.extension]}
    >
      <EditorContent editor={null} />
    </EditorProvider>
  ) : (
    <button onClick={() => sync.create(EMPTY_DOC)}>Create document</button>
  );
}
```

Features:

- Safely merges changes between clients via operational transformations (OT).
- Simple React hook to fetch the initial document and keep it in sync via a
  Tiptap extension.
- Server-side entrypoints for authorizing reads, writes, and snapshots.
- Create a new document, online or offline.
- Debounced snapshots allow new clients to avoid reading the full history.
- Deletion API for old snapshots & steps.

Coming soon:

- [ ] Offline editing support: cache the document and local changes in
      `sessionStorage` and sync when back online (only for active browser tab).
  - [ ] Also save snapshots (but not local edits) to `localStorage` so new tabs
        can see and edit documents offline (but won't see edits from other tabs
        until they're back online).
- [ ] Better readme & comments:
  - [ ] Links to Stack post & other resources.

Future that could be added later:

- Configuration for debouncing syncing steps (to reduce function calls).
- Option to write the concrete value each time a delta is submitted.
- Pluggable storage for ReactNative, assuming single-session.
- Warning when closing tab with unsynced changes (works by default?).
- Vacuuming controls for old deltas & snapshots.
- Add a BlockNote convenience wrapper.
- Convert it to a ProseMirror plugin instead of a Tiptap extension, so raw
  ProseMirror usecases can also use it.
- Handling edge cases, such as old clients with local changes on top of an older
  version of the document where the steps necessary for them to rebase their
  changes have since been vacuumed.
- Type parameter for the document ID for more type safety for folks using Convex
  IDs as their document IDs. Maybe even providing the validator for the document
  ID to the component client constructor.
- Drop clientIds entirely and just use two UUIDs locally to differentiate our
  changes from server-applied changes.
- Add an optional authorId to the data model to track who made which changes.

Missing features that aren't currently planned:

- Supporting documents larger than 1 Megabyte.
- Offline support that syncs changes between browser tabs or peer-to-peer.
- Syncing Yjs documents instead of ProseMirror steps. That would be done by a
  different Yjs-specific component.
- Syncing presence (e.g. showing other users' names and cursor in the UI). This
  is another thing a Yjs-oriented ProseMirror component could tackle.
- Callback to confirm rebases and handle failures in the client (during sync).
- Optimization to sync a snapshot instead of many deltas when an old client
  reconnects and doesn't have local changes.
- Handling multiple AsyncStorage instances that are restored from the same
  cloud backup, leading to multiple clients with the same clientID. For now,
  we'll assume that AsyncStorage is only used by one client at a time.
  A strategy here would be to

Found a bug? Feature request? [File it here](https://github.com/get-convex/prosemirror-sync/issues).

## Pre-requisite: Convex

You'll need an existing Convex project to use the component.
Convex is a hosted backend platform, including a database, serverless functions,
and a ton more you can learn about [here](https://docs.convex.dev/get-started).

Run `npm create convex` or follow any of the [quickstarts](https://docs.convex.dev/home) to set one up.

## Installation

Install the component package:

```ts
npm install @convex-dev/prosemirror-sync
```

Create a `convex.config.ts` file in your app's `convex/` folder and install the component by calling `use`:

```ts
// convex/convex.config.ts
import { defineApp } from "convex/server";
import prosemirrorSync from "@convex-dev/prosemirror-sync/convex.config";

const app = defineApp();
app.use(prosemirrorSync);

export default app;
```

## Usage

To use the component, you expose the API in a file in your `convex/` folder, and
use the `useTiptapSync` hook in your React components, passing in a reference to
the API you defined. For this example, we'll create the API in
`convex/example.ts`.

```ts
// convex/example.ts
import { components } from "./_generated/api";
import { ProsemirrorSync } from "@convex-dev/prosemirror-sync";

const prosemirrorSync = new ProsemirrorSync(components.prosemirrorSync);
export const {
  getSnapshot,
  submitSnapshot,
  latestVersion,
  getSteps,
  submitSteps,
} = prosemirrorSync.syncApi({
  // ...
});
```

In your React components, you can use the `useTiptapSync` hook to fetch the
initial document and keep it in sync via a Tiptap extension. **Note**: This
requires a
[`ConvexProvider`](https://docs.convex.dev/quickstart/react#:~:text=Connect%20the%20app%20to%20your%20backend)
to be in the component tree.

```tsx
// src/MyComponent.tsx
import { useTiptapSync } from "@convex-dev/prosemirror-sync/tiptap";
import { EditorContent, EditorProvider } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import { api } from "../convex/_generated/api";

function MyComponent() {
  const sync = useTiptapSync(api.example, "some-id");
  return sync.isLoading ? (
    <p>Loading...</p>
  ) : sync.initialContent !== null ? (
    <EditorProvider
      content={sync.initialContent}
      extensions={[StarterKit, sync.extension]}
    >
      <EditorContent editor={null} />
    </EditorProvider>
  ) : (
    <button onClick={() => sync.create({ type: "doc", content: [] })}>
      Create document
    </button>
  );
}
```

See a working example in [example.ts](./example/convex/example.ts) and
[App.tsx](./example/src/App.tsx).

## Notes

### Configuring the snapshot debounce interval

The snapshot debounce interval is set to one second by default.
You can specify a different interval with the `snapshotDebounceMs` option when
calling `useTiptapSync`.

A snapshot won't be sent until both of these are true:

- The document has been idle for the debounce interval.
- The current user was the last to make a change.

There can be races, but since each client will submit the snapshot for their
own change, they won't conflict with each other and are safe to apply.

### Creating a new document

You can create a new document from the client by calling `sync.create(content)`, or on the server by calling `prosemirrorSync.create(ctx, id, content)`.

The content should be a JSON object matching the
[Schema](https://tiptap.dev/docs/editor/core-concepts/schema).

For client-side document creation:

- While it's safest to wait until the server confirms the document doesn't exist
  yet (`!sync.isLoading`), you can choose to call it while offline with a newly
  created ID to start editing a new document before you reconnect.
- When the client next connects and syncs the document, it will submit the
  initial version and all local changes as steps.
- If multiple clients create the same document, it will fail if they submit
  different initial content.
- Note: if you don't open that document (`useTiptapSync`) while online, it won't
  sync.

<!-- END: Include on https://convex.dev/components -->

## Running the example locally

In one terminal, run:

```sh
npm install
cd example
npm install
# Involves signing into Convex if necessary and deploying to a Convex.
npm run dev
```

And in another terminal, run:

```sh
npm run dev:frontend
```
