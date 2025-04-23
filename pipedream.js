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

const main = async (props) => {
	log("Starting session");
	let session;
	let browser;
	let clickResult;
	let formattedDate;

	// Configuration object using passed props
	const appConfig = {
		debug_mode: props.debug_mode ?? false,
		preferred_court: props.preferred_court ?? "1",  // Default to Court 1 if not specified
		use_delay: props.use_delay ?? false  // Default to no delay
	};

	log(`Debug Mode: ${appConfig.debug_mode}`);
	log(`Preferred court: ${appConfig.preferred_court}`);
	log(`Using delay: ${appConfig.use_delay}`);

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

		session = await client.sessions.create();
		log(`Session created: ${session.id}`);
		log(`Live URL: ${session.liveUrl}`);

		browser = await connect({ browserWSEndpoint: session.wsEndpoint });
		const [page] = await browser.pages();

		// Add initial delay if enabled
		if (appConfig.use_delay) {
			log("Using 50-second delay before starting...");
			await new Promise(resolve => setTimeout(resolve, 50000));
			log("Delay completed, proceeding with booking...");
		}

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
			await page.type('form input[type="email"]', process.env.HELLO_CLUB_EMAIL, { delay: 15 });
			await page.type('form input[type="password"]', process.env.HELLO_CLUB_PASSWORD, { delay: 15 });

			await page.waitForSelector('button.firstActionButton');
			await page.click('button.firstActionButton');
		} else {
			throw new Error("Could not find email input field in the form");
		}

		// Wait for login to complete
		await page.waitForNavigation();

		// Calculate date 14 days from now
		const today = new Date();
		const futureDate = new Date(today);
		futureDate.setDate(today.getDate() + 14);
		formattedDate = futureDate.toISOString().split('T')[0];

		// Determine if the date is a weekend (0 = Sunday, 6 = Saturday)
		const isWeekend = futureDate.getDay() === 0 || futureDate.getDay() === 6;

		// Define time preferences based on day type
		const weekdayTimes = ['12:00', '13:00', '14:00', '11:00', '15:00', '16:00'];
		const weekendTimes = ['16:00', '17:00', '15:00', '18:00', '19:00', '20:00'];
		const priorityTimes = isWeekend ? weekendTimes : weekdayTimes;

		log(`Booking for ${formattedDate} (${isWeekend ? 'weekend' : 'weekday'})`);

		// Navigate to Padel bookings
		await page.goto(`https://harboroughcsc.helloclub.com/bookings/padel/${formattedDate}`);

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
		let bookingAttempts = 0;
		const MAX_BOOKING_ATTEMPTS = 3;  // Maximum number of booking attempts
		
		while (bookingAttempts < MAX_BOOKING_ATTEMPTS) {
			bookingAttempts++;
			log(`Booking attempt ${bookingAttempts} of ${MAX_BOOKING_ATTEMPTS}`);
			
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

				// Get all available slots that haven't been attempted yet
				const getAvailableSlots = () => {
					const slots = Array.from(document.querySelectorAll('.BookingGrid-cell.Slot'))
						.filter(slot => {
							const timeText = slot.querySelector('.Slot-text')?.textContent?.trim();
							const isAvailable = slot.classList.contains('available');
							// Add data attribute to track attempted slots
							if (!slot.hasAttribute('data-booking-attempted')) {
								slot.setAttribute('data-booking-attempted', 'false');
							}
							return timeText && isAvailable && slot.getAttribute('data-booking-attempted') === 'false';
						});
					return slots;
				};

				for (const targetTime of priorityTimes) {
					const availableSlots = getAvailableSlots()
						.filter(slot => {
							const timeText = slot.querySelector('.Slot-text')?.textContent?.trim();
							return timeText?.includes(targetTime);
						});

					if (availableSlots.length > 0) {
						const sortedSlots = availableSlots.sort((a, b) => {
							const courtA = getCourtInfo(a);
							const courtB = getCourtInfo(b);
							return courtB.isPreferred - courtA.isPreferred;
						});

						const slot = sortedSlots[0];
						// Mark this slot as attempted
						slot.setAttribute('data-booking-attempted', 'true');
						const courtInfo = getCourtInfo(slot);
						console.log(`Found ${targetTime} slot on ${courtInfo.name} (${courtInfo.isPreferred ? 'preferred' : 'alternative'} court):`, slot.className);

						slot.click();
						console.log('First click done, checking for modal...');

						await new Promise(resolve => setTimeout(resolve, 2500));

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

			if (!clickResult.success) {
				log('No more available slots found at preferred times');
				throw new Error('No more available slots found at preferred times');
			}

			log(`Found and clicked ${clickResult.timeBooked} slot on ${clickResult.courtBooked}${clickResult.wasPreferredCourt ? ' (preferred court)' : ' (alternative court)'}: ${clickResult.className}`);
			if (clickResult.requiredSecondClick) {
				log('Required second click due to no modal visible after first click');
			}

			await new Promise(resolve => setTimeout(resolve, clickResult.requiredSecondClick ? 3000 : 2000));

			log("Waiting for Next button in modal...");
			await page.waitForSelector('button.Button.Button--success.ng-animate-disabled', {
				visible: true,
				timeout: 10000
			});

			let isSlotAlreadyBooked = false;

			for (const buttonText of ['Next', 'Next', 'Confirm booking']) {
				const buttonClick = await page.evaluate((text) => {
					const button = document.querySelector('button.Button.Button--success.ng-animate-disabled');
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
				}, buttonText);

				if (buttonClick.success) {
					log(`Clicked ${buttonText} button: ${buttonClick.className}`);
				} else {
					log(`Failed to click ${buttonText} button: ${buttonClick.error}`);
					throw new Error(`Failed to click ${buttonText} button: ${buttonClick.error}`);
				}

				if (buttonText === 'Next') {
					await new Promise(resolve => setTimeout(resolve, 1000));

					const modalState = await page.evaluate(() => {
						const modalContent = document.querySelector('.Modal-content');
						return {
							hasModal: !!modalContent,
							modalText: modalContent?.textContent || '',
							isAlreadyBooked: modalContent?.textContent?.includes('This court already has a booking or event at this time') || false
						};
					});

					log(`Modal state after ${buttonText}: ${JSON.stringify(modalState)}`);

					if (modalState.isAlreadyBooked) {
						log('Detected slot is already booked, will try to cancel and retry with another slot');
						isSlotAlreadyBooked = true;
						
						// Click the Cancel button
						await page.evaluate(() => {
							const cancelButton = Array.from(document.querySelectorAll('button')).find(
								button => button.textContent.trim().toLowerCase() === 'cancel'
							);
							if (cancelButton) {
								cancelButton.click();
							}
						});
						
						// Wait for the modal to close
						await new Promise(resolve => setTimeout(resolve, 2000));
						break;
					}
				}

				if (buttonText === 'Confirm booking') {
					await new Promise(resolve => setTimeout(resolve, 1000));
					break;
				}

				await new Promise(resolve => setTimeout(resolve, 2000));
				await page.waitForSelector('button.Button.Button--success.ng-animate-disabled', { visible: true, timeout: 10000 });
			}

			// If the slot was already booked, continue to the next attempt
			if (isSlotAlreadyBooked) {
				log(`Booking attempt ${bookingAttempts} failed due to slot being already booked, trying next available slot...`);
				continue;
			}

			// If we reach here, booking was successful
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
		}

		// If we've exhausted all attempts
		throw new Error(`Failed to book after ${MAX_BOOKING_ATTEMPTS} attempts - all attempted slots were already booked`);

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
			date: formattedDate,
			logs: logs
		};
	}
};

// Export the main function for Pipedream
export default {
	name: "Padel Court Booking",
	description: "Automated booking system for Harborough CSC Padel courts",
	version: "0.1.0",
	props: {
		debug_mode: {
			type: "boolean",
			label: "Debug Mode",
			description: "If enabled, will simulate the booking process without making actual bookings",
			default: false,
		},
		preferred_court: {
			type: "string",
			label: "Preferred Court",
			description: "Preferred court number (1 or 2). Will try this court first if available.",
			default: "2",
			options: ["1", "2"]
		},
		use_delay: {
			type: "boolean",
			label: "Use 50s Delay",
			description: "If enabled, adds a 50-second delay before starting the booking process",
			default: false,
		}
	},
	async run({ steps, $ }) {
		// Pass the props to main function
		return await main({
			debug_mode: this.debug_mode,
			preferred_court: this.preferred_court,
			use_delay: this.use_delay
		});
	},
};