import { Hyperbrowser } from "@hyperbrowser/sdk";
import { connect } from "puppeteer-core";

export default defineComponent({
	props: {
		// Add a $_timeout prop to extend the timeout
		$_timeout: {
			type: "integer",
			default: 300000, // 5 minutes (increased from 4)
		}
	},
	async run({ steps, $ }) {
		// Initialize logs array
		let logs = [];
		const log = (message) => {
			const timestamp = new Date().toISOString();
			const formattedMessage = `${timestamp}: ${message}`;
			console.log(formattedMessage);
			logs.push(formattedMessage);
		};

		log("Starting session");
		const client = new Hyperbrowser({
			apiKey: process.env.HYPERBROWSER_API_KEY,
		});

		let session;
		let browser;
		try {
			session = await client.sessions.create();
			log(`Session created: ${session.id}`);
			log(`Live URL: ${session.liveUrl}`);

			browser = await connect({ browserWSEndpoint: session.wsEndpoint });
			const [page] = await browser.pages();

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
				await page.type('form input[type="email"]', process.env.HELLO_CLUB_EMAIL, { delay: 0 });
				await page.type('form input[type="password"]', process.env.HELLO_CLUB_PASSWORD, { delay: 0 });

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
			const formattedDate = futureDate.toISOString().split('T')[0];

			// Determine if the date is a weekend (0 = Sunday, 6 = Saturday)
			const isWeekend = futureDate.getDay() === 0 || futureDate.getDay() === 6;

			// Define time preferences based on day type
			const weekdayTimes = ['12:00', '13:00', '14:00', '11:00', '15:00'];
			const weekendTimes = ['16:00', '17:00', '15:00', '18:00', '19:00', '20:00'];
			const priorityTimes = isWeekend ? weekendTimes : weekdayTimes;

			log(`Booking for ${formattedDate} (${isWeekend ? 'weekend' : 'weekday'})`);

			// Navigate to Padel bookings
			await page.goto(`https://harboroughcsc.helloclub.com/bookings/padel/${formattedDate}`);

			// Wait for slots to appear
			log("Waiting for slots to appear...");
			await page.waitForSelector('.BookingGrid-cell.Slot', { visible: true, timeout: 30000 });
			await new Promise(resolve => setTimeout(resolve, 3000));

			// Debug info
			const debugInfo = await page.evaluate(() => {
				const slots = document.querySelectorAll('.BookingGrid-cell.Slot');
				const availableSlots = document.querySelectorAll('.BookingGrid-cell.Slot.available');
				return {
					totalSlots: slots.length,
					availableSlots: availableSlots.length,
					samplerSlotClasses: slots.length > 0 ? slots[0].className : 'no slots found',
					hasBookingGrid: !!document.querySelector('.BookingGrid')
				};
			});
			log('Debug Info:', debugInfo);

			// Early exit if no available slots
			if (debugInfo.availableSlots === 0) {
				log("No available slots found for this day");
				await browser.close();
				await client.sessions.stop(session.id);
				return $.flow.exit({
					message: "No available slots found for this day",
					logs: logs.join('\n'),
					success: false
				});
			}

			// Find and click slot based on priority
			const clickResult = await page.evaluate(async () => {
				const priorityTimes = ['12:00', '13:00', '14:00', '11:00', '15:00', '16:00'];  // keeping original times

				for (const targetTime of priorityTimes) {
					const slot = Array.from(document.querySelectorAll('.BookingGrid-cell.Slot'))
						.find(slot => {
							const timeText = slot.querySelector('.Slot-text')?.textContent?.trim();
							const isAvailable = slot.classList.contains('available');
							return timeText?.includes(targetTime) && isAvailable;
						});

					if (slot) {
						console.log(`Found ${targetTime} slot:`, slot.className);
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
							requiredSecondClick: !modalVisible,
							className: slot.className
						};
					}
				}

				return { success: false, timeBooked: null };
			});

			// Log outside of page.evaluate
			if (clickResult.success) {
				log(`Found and clicked ${clickResult.timeBooked} slot: ${clickResult.className}`);
				if (clickResult.requiredSecondClick) {
					log('Required second click due to no modal visible after first click');
				}
			} else {
				log('No available slots found at preferred times');
			}

			// Wait longer if we needed a second click
			await new Promise(resolve => setTimeout(resolve, clickResult.requiredSecondClick ? 3000 : 2000));

			// Wait for the modal with more logging
			log("Waiting for Next button in modal...");
			await page.waitForSelector('button.Button.Button--success.ng-animate-disabled', {
				visible: true,
				timeout: 10000
			});

			// Click through all buttons
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

				// Log outside of page.evaluate
				if (buttonClick.success) {
					log(`Clicked ${buttonText} button: ${buttonClick.className}`);
				} else {
					log(`Failed to click ${buttonText} button: ${buttonClick.error}`);
				}

				if (!buttonClick.success) {
					throw new Error(`Failed to click ${buttonText} button: ${buttonClick.error}`);
				}

				// For the final "Confirm booking" button, we don't need to wait for the next button
				if (buttonText === 'Confirm booking') {
					// Short wait to ensure the click registers
					await new Promise(resolve => setTimeout(resolve, 1000));
					break;
				}

				await new Promise(resolve => setTimeout(resolve, 2000));
				await page.waitForSelector('button.Button.Button--success.ng-animate-disabled', { visible: true, timeout: 10000 });
			}

			// Immediate cleanup after confirmation
			log("Booking confirmed, cleaning up...");
			await browser.close();
			browser = null;
			await client.sessions.stop(session.id);
			session = null;

			// Export and return success result
			const successResult = {
				message: "Booking completed successfully",
				logs: logs.join('\n'),
				success: true,
				timeBooked: clickResult.timeBooked,
				date: formattedDate
			};
			$.export("bookingResult", successResult);
			return successResult;

		} catch (error) {
			log(`Encountered an error: ${error}`);

			// Explicit cleanup on error
			if (browser) {
				await browser.close();
			}
			if (session) {
				await client.sessions.stop(session.id);
			}

			// Export and return error result
			const errorResult = {
				message: `Booking failed: ${error.message}`,
				logs: logs.join('\n'),
				success: false,
				error: error.message,
				timeBooked: clickResult?.timeBooked || null,
				date: formattedDate
			};
			$.export("bookingResult", errorResult);
			return errorResult;
		}
	},
})