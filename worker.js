export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === "/api/transcribe" && request.method === "POST") {
      try {
        const incomingForm = await request.formData();
        const audioFile = incomingForm.get("audio");

        if (!audioFile) {
          return new Response(JSON.stringify({ error: "No audio file provided" }), {
            status: 400,
            headers: { "Content-Type": "application/json" },
          });
        }

        const openaiForm = new FormData();
        openaiForm.append("file", audioFile, "recording.webm");
        openaiForm.append("model", "whisper-1");

        const openaiKey = await env.OPENAI_API_KEY.get();

        const openaiRes = await fetch("https://api.openai.com/v1/audio/transcriptions", {
          method: "POST",
          headers: {
            Authorization: `Bearer ${openaiKey}`,
          },
          body: openaiForm,
        });

        if (!openaiRes.ok) {
          const errText = await openaiRes.text();
          return new Response(JSON.stringify({ error: `Whisper API error: ${errText}` }), {
            status: 502,
            headers: { "Content-Type": "application/json" },
          });
        }

        const result = await openaiRes.json();
        return new Response(JSON.stringify({ transcript: result.text }), {
          headers: { "Content-Type": "application/json" },
        });
      } catch (err) {
        return new Response(JSON.stringify({ error: err.message }), {
          status: 500,
          headers: { "Content-Type": "application/json" },
        });
      }
    }

    // Everything else: serve the built static app
    return env.ASSETS.fetch(request);
  },
};
