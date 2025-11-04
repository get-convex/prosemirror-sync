import { useMemo } from "react";
import type { SyncApi } from "../client/index.js";
import { type UseSyncOptions, useTiptapSync } from "../tiptap/index.js";
import {
  type Block,
  BlockNoteEditor,
  type BlockNoteEditorOptions,
  nodeToBlock,
} from "@blocknote/core";
import type { JSONContent } from "@tiptap/core";

export type BlockNoteSyncOptions<Editor = BlockNoteEditor> = UseSyncOptions & {
  /**
   * If you pass options into the editor, you should pass them here, to ensure
   * the initialContent is parsed with the correct schema.
   */
  editorOptions?: Partial<
    Omit<BlockNoteEditorOptions<any, any, any>, "initialContent">
  >;
  /**
   * @deprecated Do `useBlockNoteSync<BlockNoteEditor>` instead.
   *
   */
  BlockNoteEditor?: Editor;
};

/**
 * A hook to sync a BlockNote editor with a Convex document.
 *
 * Usually used like:
 *
 * ```tsx
 * const sync = useBlockNoteSync(api.example, "some-id");
 * ```
 *
 * If you see an error like:
 * ```
 * Property 'options' is protected but type 'BlockNoteEditor<BSchema, ISchema, SSchema>' is not a class derived from 'BlockNoteEditor<BSchema, ISchema, SSchema>'.
 * ```
 * You can pass your own BlockNoteEditor like:
 * ```tsx
 * import { BlockNoteEditor } from "@blocknote/core";
 * //...
 * const sync = useBlockNoteSync<BlockNoteEditor>(api.example, "some-id");
 * ```
 * This is a workaround for the types of your editor not matching the editor
 * version used by prosemirror-sync.
 *
 * @param syncApi Wherever you exposed the sync api, e.g. `api.example`.
 * @param id The document ID.
 * @param opts Options to pass to the underlying BlockNoteEditor and sync opts.
 * @returns The editor, loading state, and fn to create the initial document.
 */
export function useBlockNoteSync<Editor = BlockNoteEditor>(
  syncApi: SyncApi,
  id: string,
  opts?: BlockNoteSyncOptions<Editor>,
):
  | {
      editor: null;
      isLoading: true;
      create?: (content: JSONContent) => Promise<void>;
    }
  | {
      editor: null;
      isLoading: false;
      create: (content: JSONContent) => Promise<void>;
    }
  | {
      editor: Editor;
      isLoading: false;
    } {
  const sync = useTiptapSync(syncApi, id, opts);
  const editor = useMemo(() => {
    if (sync.initialContent === null) return null;
    const editor = BlockNoteEditor.create({
      ...opts?.editorOptions,
      _headless: true,
    });
    const blocks: Block<any, any, any>[] = [];

    // Convert the prosemirror document to BlockNote blocks.
    // inspired by https://github.com/TypeCellOS/BlockNote/blob/main/packages/server-util/src/context/ServerBlockNoteEditor.ts#L42
    const pmNode = editor.pmSchema.nodeFromJSON(sync.initialContent);
    if (pmNode.firstChild) {
      pmNode.firstChild.descendants((node) => {
        blocks.push(nodeToBlock(node, editor.pmSchema));
        return false;
      });
    }
    return BlockNoteEditor.create({
      ...opts?.editorOptions,
      _tiptapOptions: {
        ...opts?.editorOptions?._tiptapOptions,
        extensions: [
          ...(opts?.editorOptions?._tiptapOptions?.extensions ?? []),
          sync.extension,
        ],
      },
      initialContent: blocks.length > 0 ? blocks : undefined,
    });
  }, [sync.initialContent]);

  if (sync.isLoading) {
    return {
      editor: null,
      isLoading: true,
      /**
       * Create the document without waiting to hear from the server.
       * Warning: Only call this if you just created the document id.
       * It's safer to wait until loading is false.
       * It's also best practice to pass in the same initial content everywhere,
       * so if two clients create the same document id, they'll both end up
       * with the same initial content. Otherwise the second client will
       * throw an exception on the snapshot creation.
       */
      create: sync.create,
    } as const;
  }
  if (!editor) {
    return {
      editor: null,
      isLoading: false,
      create: sync.create!,
    } as const;
  }
  return {
    editor: editor as unknown as Editor,
    isLoading: false,
  } as const;
}
