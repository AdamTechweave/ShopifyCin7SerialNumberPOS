import type {Config} from "@react-router/dev/config";
import {vercelPreset} from "@vercel/react-router/vite";

export default {
  ssr: true,
  // Only applied when building on Vercel, so local `npm run build` and
  // `shopify app dev` are unaffected.
  presets: process.env.VERCEL ? [vercelPreset()] : [],
} satisfies Config;
