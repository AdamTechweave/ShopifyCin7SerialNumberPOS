import {render} from "preact";

export default async () => {
  render(<Tile />, document.body);
};

function Tile() {
  return (
    <s-tile
      heading="Serial numbers"
      subheading="Placeholder"
      onClick={() => shopify.action.presentModal()}
    />
  );
}
