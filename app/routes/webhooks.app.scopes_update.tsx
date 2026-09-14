import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import sessionStorage from "../session-storage.server";

export const action = async ({ request }: ActionFunctionArgs) => {
    const { payload, session, topic, shop } = await authenticate.webhook(request);
    console.log(`Received ${topic} webhook for ${shop}`);

    const current = payload.current as string[];
    if (session) {
        session.scope = current.toString();
        await sessionStorage.storeSession(session);
    }
    return new Response();
};
