import ReactDOM from "react-dom/client";
import { App } from "./simple-admin-app";
export { App } from "./simple-admin-app";
const root = ReactDOM.createRoot(document.getElementById("root")!);
root.render(<App />);
if (import.meta.hot) import.meta.hot.dispose(() => root.unmount());
