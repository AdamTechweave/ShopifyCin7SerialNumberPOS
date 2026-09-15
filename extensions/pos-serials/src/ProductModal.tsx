import {render} from "preact";
import {useState} from "preact/hooks";
import {ProductSerials} from "./screens/ProductSerials";

// A target maps to exactly one module, so this one module serves both the
// "view serials" feature (this task) and "transform serial" (next task).
type Screen = "menu" | "serials" | "transform";

export default async () => {
  render(<ProductModal />, document.body);
};

function ProductModal() {
  const [screen, setScreen] = useState<Screen>("menu");

  if (screen === "serials") {
    return <ProductSerials onDone={() => setScreen("menu")} />;
  }

  if (screen === "transform") {
    // Placeholder — the next task replaces this with the real transform
    // screen. Not meant to ship as-is.
    return (
      <s-page heading="Transform serial">
        <s-section>
          <s-text>{"Serial transform isn't available yet."}</s-text>
        </s-section>
        <s-button onClick={() => setScreen("menu")}>Back</s-button>
      </s-page>
    );
  }

  return (
    <s-page heading="Serial numbers">
      <s-section>
        <s-clickable onClick={() => setScreen("serials")}>
          <s-text>View serial numbers</s-text>
        </s-clickable>
        <s-clickable onClick={() => setScreen("transform")}>
          <s-text>Transform serial</s-text>
        </s-clickable>
      </s-section>
    </s-page>
  );
}
