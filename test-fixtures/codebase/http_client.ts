/**
 * HTTP client for making API requests and fetching data from servers.
 */

export class HttpClient {
	private baseUrl: string;

	constructor(baseUrl: string) {
		this.baseUrl = baseUrl;
	}

	/**
	 * Fetch data from an API endpoint.
	 */
	async fetchData(endpoint: string): Promise<unknown> {
		const response = await fetch(`${this.baseUrl}${endpoint}`);
		return response.json();
	}

	/**
	 * Send a POST request to an API endpoint.
	 */
	async postData(endpoint: string, data: unknown): Promise<unknown> {
		const response = await fetch(`${this.baseUrl}${endpoint}`, {
			method: 'POST',
			headers: {'Content-Type': 'application/json'},
			body: JSON.stringify(data),
		});
		return response.json();
	}
}
