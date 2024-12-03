import "./App.css";
import { useEditor, EditorContent } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import { api } from "../convex/_generated/api";
import { Content, Extension, getSchema } from "@tiptap/core";
import { useSync } from "@convex-dev/prosemirror-sync/tiptap";

const defaultExtensions = [StarterKit];
const schema = getSchema(defaultExtensions);

function App(props: { id: string }) {
  const sync = useSync(props.id, {
    syncApi: api.example,
    schema,
  });
  return (
    <>
      <h1>Convex Prosemirror Component Example</h1>
      <div className="card">
        {sync.isLoading ? (
          <p>Loading...</p>
        ) : sync.content !== null ? (
          <TipTap syncExtension={sync.extension} content={sync.content} />
        ) : (
          <button
            onClick={() => {
              sync.create("<p>Write something...</p>");
            }}
          >
            Create document {props.id}
          </button>
        )}
      </div>
    </>
  );
}

function TipTap(props: { syncExtension: Extension; content: Content }) {
  const editor = useEditor({
    extensions: [...defaultExtensions, props.syncExtension],
    content: props.content,
  });

  return (
    <>
      <EditorContent editor={editor} />
    </>
  );
}

export default App;
