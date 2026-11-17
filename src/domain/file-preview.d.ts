export function filePreviewKind(bytes: Uint8Array, name?: string): { kind: 'image' | 'pdf' | 'text' | 'download'; mime: string };
