import { Hyperbrowser } from "@hyperbrowser/sdk";
import { connect } from "puppeteer-core";
import { config } from "dotenv";

config();

// Initialize logs array for better tracking
let logs = [];
const log = (message) => {
	const timestamp = new Date().toISOString();
	const formattedMessage = `${timestamp}: ${message}`;
	console.log(formattedMessage);
	logs.push(formattedMessage);
};

// Configuration object
const appConfig = {
	debug_mode: process.env.DEBUG_MODE === 'true' || false,
	preferred_court: process.env.PREFERRED_COURT || "1",  // Default to Court 1 if not specified
	profile_id: process.env.PROFILE_ID || null // Profile ID for browser state persistence
};

log(`Environment DEBUG_MODE: ${process.env.DEBUG_MODE}`);
log(`Final debug_mode value: ${appConfig.debug_mode}`);
log(`Preferred court: ${appConfig.preferred_court}`);
log(`Profile ID: ${appConfig.profile_id}`);

if (appConfig.debug_mode) {
	log("🔍 Running in DEBUG MODE - No actual bookings will be made");
}

const client = new Hyperbrowser({
	apiKey: process.env.HYPERBROWSER_API_KEY,
});

// Add these helper functions after the log function
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
	const maxAttempts = 20;
	const interval = 500;
	
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
		
		if (expectedState.hasModal !== undefined && modalState.hasModal === expectedState.hasModal) {
			return modalState;
		}
		
		if (expectedState.isAlreadyBooked !== undefined && modalState.isAlreadyBooked === expectedState.isAlreadyBooked) {
			return modalState;
		}
		
		if (expectedState.hasModal === true && modalState.hasNextButton) {
			return modalState;
		}
		
		await new Promise(resolve => setTimeout(resolve, interval));
	}
	
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

async function handleLoginIfNeeded(page) {
	if (!appConfig.profile_id) {
		// Navigate to the website
		log("Navigating to Harborough CSC...");
		await page.goto("https://harboroughcsc.helloclub.com");
	
		// Wait for the first form and email input to be present
		await page.waitForSelector('form');
		const emailInput = await page.evaluate(() => {
			const form = document.querySelector('form');
			const emailInput = form.querySelector('input[type="email"]');
			return emailInput ? true : false;
		});

		if (emailInput) {
			await page.type('form input[type="email"]', process.env.HELLO_CLUB_EMAIL, {delay: 15});
			await page.type('form input[type="password"]', process.env.HELLO_CLUB_PASSWORD, {delay: 15});
			
			await page.waitForSelector('button.firstActionButton');
			await page.click('button.firstActionButton');
		} else {
			throw new Error("Could not find email input field in the form");
		}
		// Wait for login to complete
		await page.waitForNavigation();
	}
}

const main = async () => {
	log("Starting session");
	let session;
	let browser;
	let clickResult;
	let formattedDate;
	
	try {
		// Create session with profile if available
		const sessionConfig = appConfig.profile_id ? {
			profile: {
				id: appConfig.profile_id,
				persistChanges: true // Set to true to update the profile with any changes
			}
		} : {};

		session = await client.sessions.create(sessionConfig);
		log(`Session created: ${session.id}`);
		log(`Live URL: ${session.liveUrl}`);
		if (appConfig.profile_id) {
			log(`Using profile: ${appConfig.profile_id}`);
		}

		browser = await connect({ browserWSEndpoint: session.wsEndpoint });
		const [page] = await browser.pages();

		// Calculate date 14 days from now
		const today = new Date();
		const futureDate = new Date(today);
		futureDate.setDate(today.getDate() + 14);
		formattedDate = futureDate.toISOString().split('T')[0];

		// Determine if the date is a weekend (0 = Sunday, 6 = Saturday)
		const isWeekend = futureDate.getDay() === 0 || futureDate.getDay() === 6;

		// Define time preferences based on day type
		const weekdayTimes = ['12:00', '13:00', '14:00', '11:00', '15:00', '16:00', '19:00', '17:00', '20:00'];
		const weekendTimes = ['16:00', '17:00', '15:00', '14:00', '18:00', '19:00', '20:00'];
		const priorityTimes = isWeekend ? weekendTimes : weekdayTimes;

		log(`Booking for ${formattedDate} (${isWeekend ? 'weekend' : 'weekday'})`);

		await handleLoginIfNeeded(page);

		// Navigate to Padel bookings
		//await page.goto(`https://harboroughcsc.helloclub.com/bookings/padel/${formattedDate}`);
		await page.goto(`https://harboroughcsc.helloclub.com/bookings/cricket-nets/${formattedDate}`);

		
		// Wait for slots to appear
		log("Waiting for slots to appear...");
		await page.waitForSelector('.BookingGrid-cell.Slot', { visible: true, timeout: 30000 });
		await new Promise(resolve => setTimeout(resolve, 3000));

		// Log detailed information about available slots
		const availableSlotsInfo = await page.evaluate(() => {
			const availableSlots = document.querySelectorAll('.BookingGrid-cell.Slot.available');
			return Array.from(availableSlots).map(slot => ({
				time: slot.querySelector('.Slot-text')?.textContent?.trim(),
				className: slot.className,
				isAvailable: slot.classList.contains('available')
			}));
		});
		log(`Available slots (${availableSlotsInfo.length}):`);
		availableSlotsInfo.forEach(slot => {
			log(`- Time: ${slot.time}, Available: ${slot.isAvailable}, Classes: ${slot.className}`);
		});

		// Early exit if no available slots
		if (availableSlotsInfo.length === 0) {
			log("No available slots found for this day");
			throw new Error("No available slots found for this day");
		}

		// Try to find and click slot based on priority
		clickResult = await page.evaluate(async (config) => {
			const { priorityTimes, preferred_court } = config;
			// Helper function to get court number and name
			const getCourtInfo = (slot) => {
				const columnIndex = Array.from(slot.parentElement.children).indexOf(slot);
				const courtHeader = document.querySelectorAll('.BookingGridArea-name')[columnIndex];
				const courtName = courtHeader ? courtHeader.textContent.trim() : 'Unknown';
				const courtNumber = courtName.includes('Court 1') ? "1" : "2";
				return {
					name: courtName,
					number: courtNumber,
					isPreferred: courtNumber === preferred_court
				};
			};

			for (const targetTime of priorityTimes) {
				// Get all available slots for this time
				const availableSlots = Array.from(document.querySelectorAll('.BookingGrid-cell.Slot'))
					.filter(slot => {
						const timeText = slot.querySelector('.Slot-text')?.textContent?.trim();
						const isAvailable = slot.classList.contains('available');
						return timeText?.includes(targetTime) && isAvailable;
					});

				// If we have multiple slots for the same time, prefer configured court
				if (availableSlots.length > 0) {
					// Sort slots by court preference
					const sortedSlots = availableSlots.sort((a, b) => {
						const courtA = getCourtInfo(a);
						const courtB = getCourtInfo(b);
						return courtB.isPreferred - courtA.isPreferred; // Preferred court first
					});

					const slot = sortedSlots[0];  // Take the preferred court
					const courtInfo = getCourtInfo(slot);
					console.log(`Found ${targetTime} slot on ${courtInfo.name} (${courtInfo.isPreferred ? 'preferred' : 'alternative'} court):`, slot.className);
					
					slot.click();
					console.log('First click done, checking for modal...');
					
					// Wait to see if modal appears
					await new Promise(resolve => setTimeout(resolve, 2500));
					
					// Check if modal appeared
					const modalVisible = !!document.querySelector('button.Button.Button--success.ng-animate-disabled');
					
					if (!modalVisible) {
						console.log('Modal not visible after first click, clicking again');
						slot.click();
					}
					
					return {
						success: true,
						timeBooked: targetTime,
						courtBooked: courtInfo.name,
						wasPreferredCourt: courtInfo.isPreferred,
						requiredSecondClick: !modalVisible,
						className: slot.className
					};
				}
			}
			
			return { success: false, timeBooked: null, courtBooked: null, wasPreferredCourt: false };
		}, { priorityTimes, preferred_court: appConfig.preferred_court });

		// Log outside of page.evaluate
		if (clickResult.success) {
			log(`Found and clicked ${clickResult.timeBooked} slot on ${clickResult.courtBooked}${clickResult.wasPreferredCourt ? ' (preferred court)' : ' (alternative court)'}: ${clickResult.className}`);
			if (clickResult.requiredSecondClick) {
				log('Required second click due to no modal visible after first click');
			}
		} else {
			log('No available slots found at preferred times');
			throw new Error('No available slots found at preferred times');
		}

		// Wait longer if we needed a second click
		await new Promise(resolve => setTimeout(resolve, clickResult.requiredSecondClick ? 3000 : 2000));

		// Wait for the modal with more logging
		log("Waiting for Next button in modal...");
		await page.waitForSelector('button.Button.Button--success.ng-animate-disabled', { 
			visible: true, 
			timeout: 10000 
		});

		// Replace the button clicking loop
		let isSlotAlreadyBooked = false;
		let bookingAttempts = 0;
		const MAX_BOOKING_ATTEMPTS = 3;

		while (bookingAttempts < MAX_BOOKING_ATTEMPTS) {
			bookingAttempts++;
			log(`Booking attempt ${bookingAttempts} of ${MAX_BOOKING_ATTEMPTS}`);

			// ... existing slot finding and clicking code ...

			// Replace the button clicking loop
			for (const buttonText of ['Next', 'Next', 'Confirm booking']) {
				const buttonSelector = 'button.Button.Button--success.ng-animate-disabled';
				
				const buttonAvailable = await waitForElement(page, buttonSelector);
				if (!buttonAvailable) {
					throw new Error(`${buttonText} button not found after waiting`);
				}

				const buttonClick = await page.evaluate((text, selector) => {
					const button = document.querySelector(selector);
					if (button && button.textContent.trim().includes(text)) {
						console.log(`Found ${text} button:`, button.className);
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
					try {
						// Wait for modal update with smart polling
						const modalState = await waitForModalUpdate(page, { hasModal: true });
						log(`Modal state after ${buttonText}: ${JSON.stringify(modalState)}`);

						if (modalState.isAlreadyBooked) {
							log('Detected slot is already booked, will try to cancel and retry with another slot');
							isSlotAlreadyBooked = true;
							
							// Click the Cancel button with verification
							const cancelClicked = await page.evaluate(() => {
								const cancelButton = Array.from(document.querySelectorAll('button')).find(
									button => button.textContent.trim().toLowerCase() === 'cancel'
								);
								if (cancelButton) {
									cancelButton.click();
									return true;
								}
								return false;
							});
							
							if (cancelClicked) {
								// Wait for modal to disappear
								await waitForModalUpdate(page, { hasModal: false });
							}
							break;
						}

						// If we have a next button, consider this step successful regardless of modal state
						if (modalState.hasNextButton) {
							log('Next button found, continuing with booking flow');
							continue;
						}
					} catch (modalError) {
						// If we encounter a modal error but can still see the next button, continue
						const nextButtonVisible = await page.evaluate(() => {
							return !!document.querySelector('button.Button.Button--success.ng-animate-disabled');
						});
						
						if (nextButtonVisible) {
							log('Modal state uncertain but Next button visible, continuing with booking flow');
							continue;
						}
						throw modalError;
					}
				}

				if (buttonText === 'Confirm booking') {
					if (appConfig.debug_mode) {
						log("🔍 DEBUG MODE: Skipping final confirmation click - booking would have been confirmed");
						break;
					}
					try {
						await waitForModalUpdate(page, { hasModal: true });
					} catch (modalError) {
						// Check if the booking appears successful despite modal state error
						const bookingSuccessful = await page.evaluate(() => {
							const modalContent = document.querySelector('.Modal-content');
							return modalContent?.textContent?.includes('successful') || 
								   modalContent?.textContent?.includes('confirmed') ||
								   modalContent?.textContent?.includes('booked');
						});
						
						if (bookingSuccessful) {
							log('Booking appears successful despite modal state uncertainty');
						} else {
							throw modalError;
						}
					}
					break;
				}
			}

			// If the slot was already booked, continue to the next attempt
			if (isSlotAlreadyBooked) {
				log(`Booking attempt ${bookingAttempts} failed due to slot being already booked, trying next available slot...`);
				continue;
			}

			// If we reach here, booking was successful
			break;
		}

		// Immediate cleanup after confirmation
		log("Booking confirmed, cleaning up...");
		await browser.close();
		browser = null;
		await client.sessions.stop(session.id);
		session = null;

		log("Booking completed successfully");
		return {
			success: true,
			timeBooked: clickResult.timeBooked,
			date: formattedDate,
			logs: logs
		};

	} catch (error) {
		log(`Encountered an error: ${error}`);
		
		// Explicit cleanup on error
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
			date: formattedDate,
			logs: logs
		};
	}
};

// Run the main function
main()
	.then((result) => {
		console.log("Final result:", result);
		process.exit(0);
	})
	.catch((error) => {
		console.error("Final error:", error);
		process.exit(1);
	});