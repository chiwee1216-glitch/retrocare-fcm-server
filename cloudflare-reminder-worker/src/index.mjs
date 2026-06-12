export async function triggerReminderCheck(env, fetchImpl = fetch) {
  const baseUrl = String(env.RENDER_BASE_URL || "").replace(/\/+$/, "");
  const cronSecret = String(env.CRON_SECRET || "");

  if (!baseUrl || !cronSecret) {
    throw new Error("RENDER_BASE_URL and CRON_SECRET are required");
  }

  const url = `${baseUrl}/internal/check-medicine-reminders`;
  let lastError;

  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const response = await fetchImpl(url, {
        method: "POST",
        headers: {
          accept: "application/json",
          "x-cron-secret": cronSecret,
        },
        signal: AbortSignal.timeout(8000),
      });

      if (response.ok) {
        const text = await response.text();
        return {
          status: response.status,
          body: text ? JSON.parse(text) : null,
        };
      }

      if (response.status >= 500 && attempt < 2) {
        continue;
      }

      const responseText = await response.text();
      throw new Error(
        `Render reminder check failed with status ${response.status}: ${responseText}`
      );
    } catch (error) {
      lastError = error;
      const isHttpError = /status \d{3}/.test(String(error.message || ""));

      if (isHttpError || attempt === 2) {
        throw error;
      }
    }
  }

  throw lastError || new Error("Render reminder check failed");
}

export default {
  scheduled(controller, env, ctx) {
    ctx.waitUntil(
      triggerReminderCheck(env).then((result) => {
        console.log("Reminder scheduler result", {
          scheduledTime: controller.scheduledTime,
          status: result.status,
          body: result.body,
        });
      })
    );
  },
};
