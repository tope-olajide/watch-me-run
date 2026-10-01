import { createRoot } from "react-dom/client";
import App from "./App";
import { installAudioUnlock } from "./game/audio";
import "./styles.css";

// The soundtrack is armed here rather than in a component: the first gesture that may start it can
// land anywhere — a world card, the character rail, the picture upload, or Start itself — and it has
// to outlive every one of those surfaces, because the music runs from the menu into the run.
installAudioUnlock();

createRoot(document.getElementById("root")!).render(<App />);
