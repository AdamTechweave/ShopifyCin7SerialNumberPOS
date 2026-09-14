import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import sessionStorage from "../session-storage.server";

export const action = async ({ request }: ActionFunctionArgs) => {
  const { shop, session, topic } = await authenticate.webhook(request);

  console.log(`Received ${topic} webhook for ${shop}`);

  // Webhook requests can trigger multiple times and after an app has already been uninstalled.
  // If this webhook already ran, the session may have been deleted previously.
  if (session) {
    const sessions = await sessionStorage.findSessionsByShop(shop);
    await sessionStorage.deleteSessions(sessions.map(({ id }) => id));
  }

  return new Response();
};
