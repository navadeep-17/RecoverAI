interface ImportMetaEnv {
  readonly DEV: boolean;
  readonly VITE_API_BASE_URL?: string;
  readonly VITE_DEV_MERCHANT_ID?: string;
  readonly VITE_DEV_USER_ID?: string;
  readonly VITE_DEV_USER_ROLE?: string;
}
interface ImportMeta { readonly env: ImportMetaEnv; }
