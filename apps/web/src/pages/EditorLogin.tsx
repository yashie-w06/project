import { FormEvent, useState } from "react";
import { useNavigate } from "react-router-dom";
import { api } from "../api";

export function EditorLogin() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const navigate = useNavigate();
  async function submit(e: FormEvent) {
    e.preventDefault();
    setError("");
    try {
      const result = await api.login(email, password);
      sessionStorage.setItem("editorToken", result.token);
      navigate("/edit");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Login failed");
    }
  }
  return (
    <main className="login-page">
      <form className="login-card" onSubmit={submit}>
        <span className="eyebrow">Designated editor</span>
        <h1>Campus map editor</h1>
        <p>Review routes, publish alerts, and maintain floor layouts.</p>
        <label className="field">
          Email
          <input
            type="email"
            required
            value={email}
            onChange={(e) => setEmail(e.target.value)}
          />
        </label>
        <label className="field">
          Password
          <input
            type="password"
            required
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
        </label>
        {error && <p className="error">{error}</p>}
        <button className="primary full">Sign in</button>
        <a href="/">Return to public map</a>
      </form>
    </main>
  );
}
