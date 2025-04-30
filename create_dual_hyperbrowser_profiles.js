#!/usr/bin/env node

import { Hyperbrowser } from "@hyperbrowser/sdk";
import { connect } from "puppeteer-core";
import { config } from "dotenv";

config();

async function createProfileAndLogin({ email, password, label, apiKey }) {
  let logs = [];
  const log = (msg) => {
    const timestamp = new Date().toISOString();
    const formatted = `${timestamp}: [${label}] ${msg}`;
    console.log(formatted);
    logs.push(formatted);
  };

  const client = new Hyperbrowser({
    apiKey: apiKey,
  });

  let session;
  let browser;
  let profile;
  try {
    profile = await client.profiles.create();
    log(`Profile created: ${profile.id}`);

    session = await client.sessions.create({
      profile: { id: profile.id, persistChanges: true },
    });
    log(`Session created: ${session.id}`);
    log(`Live URL: ${session.liveUrl}`);

    browser = await connect({ browserWSEndpoint: session.wsEndpoint });
    const [page] = await browser.pages();

    // Login logic
    log("Navigating to Harborough CSC...");
    await page.goto("https://harboroughcsc.helloclub.com");
    await page.waitForSelector('form');
    const emailInput = await page.evaluate(() => {
      const form = document.querySelector('form');
      const emailInput = form.querySelector('input[type="email"]');
      return emailInput ? true : false;
    });
    if (emailInput) {
      await page.type('form input[type="email"]', email, { delay: 15 });
      await page.type('form input[type="password"]', password, { delay: 15 });
      await page.waitForSelector('button.firstActionButton');
      await page.click('button.firstActionButton');
    } else {
      throw new Error("Could not find email input field in the form");
    }
    await page.waitForNavigation();
    log("Login successful");
    await browser.close();
    await client.sessions.stop(session.id);
    return {
      success: true,
      profile_id: profile.id,
      session_id: session.id,
      liveUrl: session.liveUrl,
      logs,
    };
  } catch (error) {
    log(`Encountered an error: ${error}`);
    if (browser) await browser.close();
    if (session) await client.sessions.stop(session.id);
    return {
      success: false,
      error: error.message,
      logs,
    };
  }
}

(async () => {
  const users = [
    {
      label: "STEFAN",
      email: process.env.HELLO_CLUB_EMAIL,
      password: process.env.HELLO_CLUB_PASSWORD,
      apiKey: process.env.HYPERBROWSER_API_KEY,
    },
    {
      label: "JOANNA",
      email: process.env.HELLO_CLUB_EMAIL_JOANNA,
      password: process.env.HELLO_CLUB_PASSWORD_JOANNA,
      apiKey: process.env.HYPERBROWSER_API_KEY_JOANNA,
    },
  ];

  for (const user of users) {
    if (!user.email || !user.password || !user.apiKey) {
      console.error(`Missing credentials for ${user.label}`);
      continue;
    }
    const result = await createProfileAndLogin(user);
    if (result.success) {
      console.log(`\n✅ [${user.label}] Session/profile created and logged in!`);
      console.log(`[${user.label}] Profile ID:`, result.profile_id);
      console.log(`[${user.label}] Session ID:`, result.session_id);
      console.log(`[${user.label}] Live URL:  `, result.liveUrl);
    } else {
      console.error(`\n❌ [${user.label}] Failed:`, result.error);
    }
  }
})(); 