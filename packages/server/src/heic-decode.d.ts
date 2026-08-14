/**
 * Ambient types for `heic-decode` (ships no TypeScript types): WASM libheif + libde265, so it
 * decodes HEVC-encoded HEIC — which sharp's prebuilt libvips cannot — on any platform.
 */
declare module 'heic-decode' {
  function decode(input: { buffer: Buffer | Uint8Array }): Promise<{
    width: number;
    height: number;
    /** RGBA pixel data, `width * height * 4` bytes. */
    data: Uint8ClampedArray;
  }>;
  export = decode;
}
