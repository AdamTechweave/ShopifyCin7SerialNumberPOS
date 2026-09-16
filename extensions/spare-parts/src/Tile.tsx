import "@shopify/ui-extensions/preact";
import {render} from "preact";

export default async () => {
  render(<Extension />, document.body);
};

function Extension() {
  return (
    <s-tile
      heading="Spare Parts"
      subheading="Add a custom-price item"
      onClick={() => shopify.action.presentModal()}
    />
  );
}
