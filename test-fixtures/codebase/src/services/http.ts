/**
 * Fixture for refs extraction: HttpClient is used outside its definition file.
 */
import {HttpClient} from '../../http_client';

const client = new HttpClient('https://api.example.com');

export async function fetchJson(path: string): Promise<unknown> {
	return client.fetchData(path);
}
