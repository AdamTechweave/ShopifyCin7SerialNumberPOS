import "@shopify/ui-extensions/preact";
import {render} from "preact";

export default async () => {
  render(<Extension />, document.body);
};

function Extension() {
  return (
    <s-tile
      heading="Labour"
      subheading="Add a labour charge"
      onClick={() => shopify.action.presentModal()}
    />
  );
}
