// ---------------------------------------------------------------------------------------------
// Added by deploy/naive-hosted when it assembles the Naive-hosted build. This is not in the
// repo's source: packages/core/src/integrations/index.ts is unchanged, and the regular Vercel
// and Render deployment never sees this code.
//
// In the Naive-hosted build:
// - an integration without a key uses its fake instead of failing boot, so the build runs with
//   only a Naive key;
// - email never reaches anyone but the test inbox. Without NAIVE_HOSTED_TEST_INBOX, AgentMail is
//   always the fake. With it, the real AgentMail client is used, but every send to any other
//   address is refused before it leaves the process.
// ---------------------------------------------------------------------------------------------

function restrictToTestInbox(mail: Integrations["agentmail"], testInbox: string): Integrations["agentmail"] {
  const allowed = (to: string): void => {
    if (to.trim().toLowerCase() !== testInbox) {
      throw new ConfigError(`naive-hosted: email to ${to} refused; only ${testInbox} may receive mail`);
    }
  };
  return {
    send: async (msg) => {
      allowed(msg.to);
      return mail.send(msg);
    },
    sendTransactional: async (msg) => {
      allowed(msg.to);
      return mail.sendTransactional(msg);
    },
  };
}

export function createIntegrations(
  config: Config,
  real: Parameters<typeof createIntegrationsOriginal>[1] = {},
): Selection {
  const testInbox = process.env.NAIVE_HOSTED_TEST_INBOX?.trim().toLowerCase() || undefined;
  const { agentmail: realAgentMail, sendTransactional: _ignored, ...rest } = real;
  const selection = createIntegrationsOriginal(
    { ...config, isProd: false },
    testInbox && realAgentMail ? { ...rest, agentmail: realAgentMail } : rest,
  );
  const usingFakeMail = selection.fakes.includes("agentmail");
  const mail =
    testInbox && !usingFakeMail
      ? restrictToTestInbox(selection.integrations.agentmail, testInbox)
      : selection.integrations.agentmail;
  selection.integrations.agentmail = mail;
  selection.integrations.sendTransactional = mail.sendTransactional;
  return selection;
}
