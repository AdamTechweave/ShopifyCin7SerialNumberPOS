import {render} from "preact";

export default async () => {
  render(<Modal />, document.body);
};

function Modal() {
  return (
    <s-page heading="Serial numbers">
      <s-text>Placeholder</s-text>
    </s-page>
  );
}
