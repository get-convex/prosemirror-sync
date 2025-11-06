# Changelog

## 0.2.0

- Adds /test and /_generated/component.js entrypoints
- Drops commonjs support
- Improves source mapping for generated files
- Changes to a statically generated component API

## 0.1.28

- Imports with file extensions to help module resolution for NodeNext

## 0.1.27

- Reduce the number of deltas in one round to avoid returning too long of arrays
  of steps when catching up old clients

## 0.1.26

- Support 0.34 up to 1.0

## 0.1.25

- Support BlockNote ^0.33

## 0.1.24

- Change the BlockNoteEditor to be a type parameter instead, as mismatched
  versions were still unhappy due to subclass checks.

## 0.1.23

- Enable passing in the BlockNoteEditor in the useBlockNoteSync hook to avoid
  type errors when passing the resulting editor to BlockNoteView.
