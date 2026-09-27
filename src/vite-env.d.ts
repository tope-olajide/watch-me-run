/// <reference types="vite/client" />

declare module "*.fbx?url" {
  const source: string;
  export default source;
}
