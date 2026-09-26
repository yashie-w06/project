import { BrowserRouter, Navigate, Route, Routes } from "react-router-dom";
import { PublicMap } from "./pages/PublicMap";
import { EditorLogin } from "./pages/EditorLogin";
import { Editor } from "./pages/Editor";

export function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/" element={<PublicMap />} />
        <Route path="/edit/login" element={<EditorLogin />} />
        <Route path="/edit" element={<Editor />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </BrowserRouter>
  );
}
