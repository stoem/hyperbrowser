import { Hyperbrowser } from "@hyperbrowser/sdk";
import { connect } from "puppeteer-core";
import { config } from "dotenv";

config();

const client = new Hyperbrowser({
	apiKey: process.env.HYPERBROWSER_API_KEY,
});

const main = async () => {
	console.log("Starting session");
	const session = await client.sessions.create();
	console.log("Session created:", session.id);
	console.log("Live URL:", session.liveUrl); // You can watch the automation live here

	try {
		const browser = await connect({ browserWSEndpoint: session.wsEndpoint });
		const [page] = await browser.pages();

		// Navigate to the website
		console.log("Navigating to Harborough CSC...");
		await page.goto("https://harboroughcsc.helloclub.com");
		
		// Wait for the first form and email input to be present
		await page.waitForSelector('form');  // Wait for any form
		const emailInput = await page.evaluate(() => {
			const form = document.querySelector('form');
			const emailInput = form.querySelector('input[type="email"]');
			return emailInput ? true : false;
		});

		if (emailInput) {
			// Type faster by setting a lower delay (default is 50ms)
			await page.type('form input[type="email"]', process.env.HELLO_CLUB_EMAIL, {delay: 0});
			await page.type('form input[type="password"]', process.env.HELLO_CLUB_PASSWORD, {delay: 0});
			
			// Wait for and click the button with firstActionButton class
			await page.waitForSelector('button.firstActionButton');
			await page.click('button.firstActionButton');
		} else {
			console.error("Could not find email input field in the form");
		}

		// Wait for login to complete and navigation to finish
		await page.waitForNavigation();
		
		// Calculate date 14 days from now
		const today = new Date();
		const futureDate = new Date(today);
		futureDate.setDate(today.getDate() + 14);

		// Format the date as YYYY-MM-DD
		const formattedDate = futureDate.toISOString().split('T')[0];

		// Navigate to Padel bookings for the specific date
		//console.log(`https://harboroughcsc.helloclub.com/bookings/padel/${formattedDate}`);
		//await page.goto(`https://harboroughcsc.helloclub.com/bookings/padel/${formattedDate}`);
		await page.goto(`https://harboroughcsc.helloclub.com/bookings/padel/2025-04-17`);
		
		// Cricket nets can be used for testing
		//await page.goto(`https://harboroughcsc.helloclub.com/bookings/cricket-nets/${formattedDate}`);

		// Wait for any slot to appear (this is more specific than waiting for the grid)
		console.log("Waiting for slots to appear...");
		await page.waitForSelector('.BookingGrid-cell.Slot', { visible: true, timeout: 30000 });

		// Add a small wait to ensure Angular has finished rendering
		await new Promise(resolve => setTimeout(resolve, 3000));

		// Debug: Let's see what we actually have on the page
		const debugInfo = await page.evaluate(() => {
			const slots = document.querySelectorAll('.BookingGrid-cell.Slot');
			const availableSlots = document.querySelectorAll('.BookingGrid-cell.Slot.available');
			
			return {
				totalSlots: slots.length,
				availableSlots: availableSlots.length,
				samplerSlotClasses: slots.length > 0 ? slots[0].className : 'no slots found',
				hasBookingGrid: !!document.querySelector('.BookingGrid'),
				pageContent: document.body.innerHTML.length // just to check if page has content
			};
		});

		console.log('Debug Info:', debugInfo);

		// Now find all slots and their status
		const allSlots = await page.evaluate(() => {
			const slots = Array.from(document.querySelectorAll('.BookingGrid-cell.Slot'));
			return slots.map(slot => ({
				isAvailable: slot.classList.contains('available'),
				timeText: slot.querySelector('.Slot-text')?.textContent?.trim() || 'no time',
				isClickable: !slot.classList.contains('disabled')
			}));
		});

		console.log('Found slots:', allSlots);

		// Try to find and click a slot based on priority
		const clickResult = await page.evaluate(async () => {
			const priorityTimes = ['12:00', '13:00', '14:00', '11:00', '15:00', '08:00'];
			
			for (const targetTime of priorityTimes) {
				const slot = Array.from(document.querySelectorAll('.BookingGrid-cell.Slot'))
					.find(slot => {
						const timeText = slot.querySelector('.Slot-text')?.textContent?.trim();
						const isAvailable = slot.classList.contains('available');
						return timeText?.includes(targetTime) && isAvailable;
					});

				if (slot) {
					console.log(`Found ${targetTime} slot:`, slot.className);
					
					// First click
					slot.click();
					console.log('First click done, checking for modal...');
					
					// Give the modal a moment to appear
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
						requiredSecondClick: !modalVisible
					};
				}
			}
			
			console.log('No slots found at preferred times (12:00, 13:00, 14:00, 11:00, 15:00, 08:00)');
			return { success: false, timeBooked: null };
		});

		console.log('Click result:', clickResult);

		// Wait a moment to see the result of clicking
		// Adding extra time if we needed a double click
		await new Promise(resolve => setTimeout(resolve, clickResult.requiredSecondClick ? 3000 : 2000));

		// Now wait for modal to appear and the Next button to be present
		console.log("Waiting for Next button in modal...");
		await page.waitForSelector('button.Button.Button--success.ng-animate-disabled', { visible: true, timeout: 10000 });

		// Click the Next button
		const nextButtonClick = await page.evaluate(() => {
			const button = document.querySelector('button.Button.Button--success.ng-animate-disabled');
			if (button && button.textContent.trim().includes('Next')) {
				console.log('Found Next button:', button.className);
				button.click();
				return { success: true };
			}
			return { 
				success: false, 
				error: 'Next button not found or not clickable',
				buttonFound: !!button
			};
		});

		console.log('Next button click result:', nextButtonClick);

		// Wait for the second Next button to appear
		console.log("Waiting for second Next button...");
		await page.waitForSelector('button.Button.Button--success.ng-animate-disabled', { visible: true, timeout: 10000 });

		// Click the second Next button
		const secondNextClick = await page.evaluate(() => {
			const button = document.querySelector('button.Button.Button--success.ng-animate-disabled');
			if (button && button.textContent.trim().includes('Next')) {
				console.log('Found second Next button:', button.className);
				button.click();
				return { success: true };
			}
			return { 
				success: false, 
				error: 'Second Next button not found or not clickable',
				buttonFound: !!button
			};
		});

		console.log('Second Next button click result:', secondNextClick);

		// Wait for Confirm Booking button to appear
		console.log("Waiting for Confirm Booking button...");
		await page.waitForSelector('button.Button.Button--success.ng-animate-disabled', { visible: true, timeout: 10000 });

		// Click the Confirm Booking button
		const confirmClick = await page.evaluate(() => {
			const button = document.querySelector('button.Button.Button--success.ng-animate-disabled');
			if (button && button.textContent.trim().includes('Confirm booking')) {
				console.log('Found Confirm booking button:', button.className);
				button.click();
				return { success: true };
			}
			return { 
				success: false, 
				error: 'Confirm booking button not found or not clickable',
				buttonFound: !!button
			};
		});

		console.log('Confirm booking click result:', confirmClick);

		// Wait after clicking to see the result
		await new Promise(resolve => setTimeout(resolve, 10000));

		// Clean up
		await page.close();
		await browser.close();
	} catch (error) {
		console.error(`Encountered an error: ${error}`);
	} finally {
		// Make sure to stop the session when done
		await client.sessions.stop(session.id);
		console.log("Session stopped:", session.id);
	}
};

main().catch(console.error);