import {render} from "preact";
import {useState} from "preact/hooks";
import {ProductSerials} from "./screens/ProductSerials";
import {SerialTransform} from "./screens/SerialTransform";

// A target maps to exactly one module, so this one module serves both the
// "view serials" feature and "transform serial" feature.
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
    return <SerialTransform onDone={() => setScreen("menu")} />;
  }

  return (
    <s-page heading="Serial numbers">
      <s-section>
        {/* Buttons, not clickable text: the text rows were too small a tap
            target on a handheld. */}
        <s-button onClick={() => setScreen("serials")}>View serial numbers</s-button>
        <s-button onClick={() => setScreen("transform")}>Transform serial</s-button>
      </s-section>
    </s-page>
  );
}
