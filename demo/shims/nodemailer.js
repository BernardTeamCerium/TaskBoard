// Email isn't available in the browser demo.
export default { createTransport: () => ({ sendMail: async () => { throw new Error('Email is disabled in the demo'); } }) };
