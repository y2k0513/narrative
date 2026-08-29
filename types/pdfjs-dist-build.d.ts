declare module "pdfjs-dist/build/pdf.mjs" {
  export const version: string;

  export const GlobalWorkerOptions: {
    workerSrc: string;
  };

  export function getDocument(options: {
    data: Uint8Array;
    useSystemFonts?: boolean;
  }): {
    promise: Promise<{
      numPages: number;
      getPage(pageNumber: number): Promise<{
        getTextContent(): Promise<{
          items: unknown[];
        }>;
      }>;
    }>;
  };
}
