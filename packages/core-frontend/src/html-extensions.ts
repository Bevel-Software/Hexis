// Non-standard but widely-supported HTML attributes that React's typings omit.
// `webkitdirectory` makes `<input type="file">` enumerate the contents of a
// chosen directory (with `File.webkitRelativePath` populated). Used by the
// FileExplorer's "Add folder" picker.

import 'react';

declare module 'react' {
  interface InputHTMLAttributes<T> extends HTMLAttributes<T> {
    webkitdirectory?: string;
  }
}
