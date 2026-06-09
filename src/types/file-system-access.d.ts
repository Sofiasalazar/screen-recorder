// Minimal ambient declarations for the File System Access API picker.
// FileSystemFileHandle and FileSystemWritableFileStream are already in
// lib.dom.d.ts in modern TS, but showSaveFilePicker on Window is not.
interface SaveFilePickerAcceptType {
  description?: string;
  accept: Record<string, string[]>;
}

interface SaveFilePickerOptions {
  suggestedName?: string;
  types?: SaveFilePickerAcceptType[];
  excludeAcceptAllOption?: boolean;
}

interface Window {
  showSaveFilePicker?: (
    opts?: SaveFilePickerOptions,
  ) => Promise<FileSystemFileHandle>;
}
