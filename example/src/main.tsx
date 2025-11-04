import { createRoot } from "react-dom/client";
import { ConvexProvider, ConvexReactClient } from "convex/react";
import App from "./App.tsx";
import "./index.css";

const address = import.meta.env.VITE_CONVEX_URL;

const convex = new ConvexReactClient(address);

// Fetch the id from the URL hash, or make a new one
if (window.location.hash.length <= 1) {
  window.location.hash = `#blocknote-${crypto.randomUUID()}`;
}
window.addEventListener("hashchange", () => {
  window.location.reload();
});
const id = window.location.hash.slice(1);

createRoot(document.getElementById("root")!).render(
  <ConvexProvider client={convex}>
    <App id={id} />
  </ConvexProvider>,
);
