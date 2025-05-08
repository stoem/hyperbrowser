import { Hyperbrowser } from "@hyperbrowser/sdk";
import { connect } from "puppeteer-core";

// Initialize logs array for better tracking
let logs = [];
const log = (message) => {
	const timestamp = new Date().toISOString();
	const formattedMessage = `${timestamp}: ${message}`;
	console.log(formattedMessage);
	logs.push(formattedMessage);
};

const parseEmailSubject = (subject, $) => {
	log(`Attempting to parse email subject: "${subject}"`);

	// First check if this is even a court release email
	if (!subject.toLowerCase().includes('padel court available')) {
		log("Not a Padel court release email - skipping");
		$.flow.exit("Not a Padel court release email - skipping");
		return null; // This line won't execute due to $.flow.exit, but good practice
	}

	// Expected format: "Padel court available for Saturday 26 April at 19:00"
	// But be more flexible with the pattern
	const regex = /court available for (\w+) (\d+)\w* (\w+) at (\d{1,2}:\d{2})/i;
	const match = subject.match(regex);

	if (!match) {
		log("Failed to parse subject with regex. Subject format not recognized.");
		log("Expected format example: 'Padel court available for Saturday 26 April at 19:00'");
		$.flow.exit("Could not parse email subject format");
		return null;
	}

	const [_, day, dateNum, month, time] = match;
	log(`Parsed components: day=${day}, date=${dateNum}, month=${month}, time=${time}`);

	// Convert to proper date object
	const year = new Date().getFullYear();
	const dateStr = `${dateNum} ${month} ${year}`;
	const targetDate = new Date(dateStr);

	// Validate the date is valid
	if (isNaN(targetDate.getTime())) {
		log(`Invalid date created from: ${dateStr}`);
		$.flow.exit("Invalid date in email subject");
		return null;
	}

	// Format date for URL
	const formattedDate = targetDate.toISOString().split('T')[0];

	const result = {
		day,
		date: formattedDate,
		time,
		originalDate: `${dateNum} ${month}`,
	};

	log(`Successfully parsed booking details: ${JSON.stringify(result)}`);
	return result;
};

const waitForElement = async (page, selector, options = {}) => {
	const defaultOptions = {
		visible: true,
		timeout: 5000,
		polling: 100
	};
	const mergedOptions = { ...defaultOptions, ...options };

	try {
		await page.waitForSelector(selector, mergedOptions);
		return true;
	} catch (error) {
		log(`Timeout waiting for element: ${selector}`);
		return false;
	}
};

const waitForModalUpdate = async (page, expectedState = {}) => {
	const maxAttempts = 20; // Increased from 10
	const interval = 500; // Increased from 200

	for (let i = 0; i < maxAttempts; i++) {
		const modalState = await page.evaluate(() => {
			const modalContent = document.querySelector('.Modal-content');
			const nextButton = document.querySelector('button.Button.Button--success.ng-animate-disabled');
			return {
				hasModal: !!modalContent || !!nextButton,
				modalText: modalContent?.textContent || '',
				isAlreadyBooked: modalContent?.textContent?.includes('This court already has a booking or event at this time') || false,
				hasNextButton: !!nextButton
			};
		});

		// If we're looking for a modal and found one, or looking for no modal and found none
		if (expectedState.hasModal !== undefined && modalState.hasModal === expectedState.hasModal) {
			return modalState;
		}

		// If we're checking for already booked status
		if (expectedState.isAlreadyBooked !== undefined && modalState.isAlreadyBooked === expectedState.isAlreadyBooked) {
			return modalState;
		}

		// If we found a next button when we're looking for a modal
		if (expectedState.hasModal === true && modalState.hasNextButton) {
			return modalState;
		}

		await new Promise(resolve => setTimeout(resolve, interval));
	}

	// Instead of throwing, return the current state
	const finalState = await page.evaluate(() => {
		const modalContent = document.querySelector('.Modal-content');
		const nextButton = document.querySelector('button.Button.Button--success.ng-animate-disabled');
		return {
			hasModal: !!modalContent || !!nextButton,
			modalText: modalContent?.textContent || '',
			isAlreadyBooked: modalContent?.textContent?.includes('This court already has a booking or event at this time') || false,
			hasNextButton: !!nextButton
		};
	});

	return finalState;
};

async function handleLoginIfNeeded(page, useProfile) {
	if (useProfile) {
		log("Using profile, skipping login");
		return;
	}

	// Navigate to the website
	log("Navigating to Harborough CSC...");
	await page.goto("https://harboroughcsc.helloclub.com");

	log("Wait for the first form and email input to be present...");
	// Wait for the first form and email input to be present
	await page.waitForSelector('form');
	const emailInput = await page.evaluate(() => {
		const form = document.querySelector('form');
		const emailInput = form.querySelector('input[type="email"]');
		return emailInput ? true : false;
	});
	
	if (emailInput) {
		log("Email input found, typing email...");
		await page.type('form input[type="email"]', process.env.HELLO_CLUB_EMAIL, { delay: 15 });
		log("Email typed, typing password...");
		await page.type('form input[type="password"]', process.env.HELLO_CLUB_PASSWORD, { delay: 15 });
		log("Password typed, clicking first action button...");
		await page.waitForSelector('button.firstActionButton');
		await page.click('button.firstActionButton');

		// Wait a few seconds for backend login to complete
		await new Promise(resolve => setTimeout(resolve, 6000));

		// Refresh the page to complete login
		log('Refreshing page after login spinner...');
		await page.reload({ waitUntil: 'networkidle0' });
	} else {
		throw new Error("Could not find email input field in the form");
	}
}

const main = async (props, $) => {
	log("Starting session");
	let session;
	let browser;
	let clickResult;

	// Parse the email subject
	const bookingDetails = parseEmailSubject(props.subject, $);
	log(`Parsed booking details: ${JSON.stringify(bookingDetails)}`);

	// Configuration object using passed props
	const appConfig = {
		debug_mode: props.debug_mode ?? false,
		profile_id: props.profile_id || process.env.PROFILE_ID || null,
		targetDate: bookingDetails.date,
		targetTime: bookingDetails.time
	};

	log(`Debug Mode: ${appConfig.debug_mode}`);
	if (appConfig.profile_id) {
		log(`Using profile: ${appConfig.profile_id}`);
	}
	log(`Target booking: ${bookingDetails.day} ${bookingDetails.originalDate} at ${bookingDetails.time}`);

	if (appConfig.debug_mode) {
		log("🔍 Running in DEBUG MODE - No actual bookings will be made");
	}

	const client = new Hyperbrowser({
		apiKey: process.env.HYPERBROWSER_API_KEY,
	});

	try {
		// Skip actual booking in debug mode
		if (appConfig.debug_mode) {
			log("Debug mode: Simulating successful booking");
			return {
				success: true,
				debug: true,
				message: "Debug mode - booking simulated",
				logs: logs
			};
		}

		// Create session with profile if available
		const sessionConfig = appConfig.profile_id ? {
			profile: {
				id: appConfig.profile_id,
				persistChanges: true
			}
		} : {};

		session = await client.sessions.create(sessionConfig);
		log(`Session created: ${session.id}`);
		log(`Live URL: ${session.liveUrl}`);

		browser = await connect({ browserWSEndpoint: session.wsEndpoint });
		const [page] = await browser.pages();

		await handleLoginIfNeeded(page, !!appConfig.profile_id);

		// Navigate to Padel bookings for the specific date
		log(`Navigating to Padel bookings for the specific date ${appConfig.targetDate}`);
		await page.goto(`https://harboroughcsc.helloclub.com/bookings/padel/${appConfig.targetDate}`);

		// Wait for slots to appear
		log("Waiting for slots to appear...");
		await page.waitForSelector('.BookingGrid-cell.Slot', { visible: true, timeout: 15000 });
		await new Promise(resolve => setTimeout(resolve, 3000));

		// Find and click the specific slot we want
		clickResult = await page.evaluate(async (targetTime) => {
			const slots = Array.from(document.querySelectorAll('.BookingGrid-cell.Slot.available'));
			const targetSlot = slots.find(slot => {
				const timeText = slot.querySelector('.Slot-text')?.textContent?.trim();
				return timeText?.includes(targetTime);
			});

			if (!targetSlot) {
				return {
					success: false,
					error: `No available slot found for ${targetTime}`
				};
			}

			// Click the slot
			targetSlot.click();
			await new Promise(resolve => setTimeout(resolve, 2500));

			const modalVisible = !!document.querySelector('button.Button.Button--success.ng-animate-disabled');

			if (!modalVisible) {
				targetSlot.click();
			}

			return {
				success: true,
				timeBooked: targetTime,
				requiredSecondClick: !modalVisible
			};
		}, appConfig.targetTime);

		if (!clickResult.success) {
			throw new Error(clickResult.error || 'Failed to find or click the target slot');
		}

		log(`Found and clicked slot for ${clickResult.timeBooked}`);
		if (clickResult.requiredSecondClick) {
			log('Required second click due to no modal visible after first click');
		}

		// Wait for booking modal to appear
		log("Waiting for booking modal...");
		const modalState = await waitForModalUpdate(page, { hasModal: true });

		if (modalState.isAlreadyBooked) {
			throw new Error("Court is already booked for this time slot");
		}

		// Use the more robust button handling approach for all three steps
		for (const buttonText of ['Next', 'Next', 'Confirm booking']) {
			const buttonSelector = 'button.Button.Button--success.ng-animate-disabled';

			// Wait for button to be available
			log(`Waiting for ${buttonText} button...`);
			const buttonAvailable = await waitForElement(page, buttonSelector);
			if (!buttonAvailable) {
				throw new Error(`${buttonText} button not found after waiting`);
			}

			// Click the button and verify the click
			const buttonClick = await page.evaluate((text, selector) => {
				const button = document.querySelector(selector);
				if (button && button.textContent.trim().includes(text)) {
					console.log(`Found ${text} button:`, button.className);
					// Add visual feedback
					button.style.border = '3px solid green';
					button.click();
					return {
						success: true,
						className: button.className
					};
				}
				return {
					success: false,
					error: `${text} button not found or not clickable`,
					buttonFound: !!button
				};
			}, buttonText, buttonSelector);

			if (buttonClick.success) {
				log(`Clicked ${buttonText} button: ${buttonClick.className}`);
			} else {
				log(`Failed to click ${buttonText} button: ${buttonClick.error}`);
				throw new Error(`Failed to click ${buttonText} button: ${buttonClick.error}`);
			}

			if (buttonText === 'Next') {
				// Wait for modal update with smart polling
				const modalState = await waitForModalUpdate(page, { hasModal: true });
				log(`Modal state after ${buttonText}: ${JSON.stringify(modalState)}`);

				if (modalState.isAlreadyBooked) {
					throw new Error("Court is already booked for this time slot");
				}

				// Add a small delay to ensure UI updates are complete
				await new Promise(resolve => setTimeout(resolve, 2000));
			}

			if (buttonText === 'Confirm booking') {
				// Wait for success indication - either URL change or success message
				log("Waiting for booking completion...");
				await Promise.race([
					page.waitForNavigation({ timeout: 30000 }),
					page.waitForFunction(() => {
						return window.location.href.includes('/bookings/') ||
							document.body.textContent.includes('Booking confirmed') ||
							document.body.textContent.includes('Booking successful');
					}, { timeout: 30000 })
				]);
			}
		}

		// Add extra verification that we're on a success page
		const bookingSuccess = await page.evaluate(() => {
			return {
				url: window.location.href,
				hasSuccessMessage: document.body.textContent.includes('Booking confirmed') ||
					document.body.textContent.includes('Booking successful')
			};
		});

		log(`Final state - URL: ${bookingSuccess.url}, Success message: ${bookingSuccess.hasSuccessMessage}`);

		// Cleanup
		await browser.close();
		await client.sessions.stop(session.id);

		return {
			success: true,
			timeBooked: clickResult.timeBooked,
			date: appConfig.targetDate,
			logs: logs
		};

	} catch (error) {
		log(`Encountered an error: ${error}`);

		if (browser) {
			await browser.close();
		}
		if (session) {
			await client.sessions.stop(session.id);
		}

		return {
			success: false,
			error: error.message,
			timeBooked: clickResult?.timeBooked || null,
			date: appConfig.targetDate,
			logs: logs
		};
	}
};

// Export the main function for Pipedream
export default {
	name: "Court Released Booking",
	description: "Books a specific padel court slot when notified of availability by email",
	version: "0.1.0",
	props: {
		debug_mode: {
			type: "boolean",
			label: "Debug Mode",
			description: "If enabled, will simulate the booking process without making actual bookings",
			default: false,
		},
		profile_id: {
			type: "string",
			label: "Browser Profile ID",
			description: "Browser profile ID for session persistence. Leave empty to start fresh session.",
			optional: true,
			default: "",
		}
	},
	async run({ steps, $ }) {
		const subject = steps.trigger.event.parsedHeaders.subject;
		if (!subject) {
			$.flow.exit("No email subject found in trigger event");
			return;
		}

		// Pass the props to main function
		return await main({
			debug_mode: this.debug_mode,
			profile_id: this.profile_id,
			subject
		}, $);
	},
};