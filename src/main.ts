/* Libraries */
import fetch, { RequestRedirect } from 'node-fetch';
import { parseISO, format } from "date-fns";

/* Interfaces */
import { Company, Account, ServicePoint, DailyData, AccountHourlyData, HourlyData } from './interfaces/general';
import {GetAllAccountsResponse, MonthlyDataResponse, DailyDataResponse, HourlyDataResponse, ServicePointResponse} from './interfaces/responses';

/* Re-export types for consumers */
export { Account, ServicePoint, DailyData, AccountHourlyData, HourlyData } from './interfaces/general';

/* Interfaces */
export interface SouthernCompanyConfig{
	username: string;
	password: string;
	account?: string;
	accounts?: string[];
	company?: string;
}

export class SouthernCompanyAPI{
	private config?: SouthernCompanyConfig;
	public jwt?: string;
	private accounts: Account[] = [];

	constructor(config?: SouthernCompanyConfig){
		if(config){
			this.config = config;
		}
	}

	/* Utility Methods */
	private getConfigAccounts(): Account[]{
		/* Calculating which accounts to fetch data from */
		let accounts: Account[] = this.accounts;

		if(this.config && this.config.accounts){
			accounts = this.accounts.filter(a => this.config!.accounts!.includes(a.number.toString()));
		}
		else if(this.config && this.config.account){
			accounts = this.accounts.filter(a => this.config!.account!.includes(a.number.toString()));
		}

		/* Returning accounts array */
		return accounts;
	}

	/* Safe JSON parse helper */
	private safeJsonParse(text: string): unknown {
		try {
			return JSON.parse(text);
		} catch {
			return null;
		}
	}

	/* Format date as MM/dd/yyyy for API query params */
	private formatDateParam(date: Date): string {
		return format(date, 'MM/dd/yyyy');
	}

	/* Ensure logged in before data calls */
	private async ensureLoggedIn(jwt?: string): Promise<void> {
		if(!jwt && !this.jwt){
			await this.login(this.config);
		}
		if(!this.jwt){
			throw new Error('Not logged in');
		}
	}

	/* API methods */
	private async getRequestVerificationToken(username: string, password: string): Promise<string>{
		/* Grabbing login page */
		const response = await fetch('https://webauth.southernco.com/webservices/api/WebUser/Login', {
			method: 'POST',
			headers: {
				"referer": "https://webauth.southernco.com/SPA/OCC/login",
				"content-type": "application/json"
			},
			body: JSON.stringify({
				"username": username,
				"password": password
			})
		});

		/* Checking for unsuccessful login */
		if(response.status !== 200){
			throw new Error(`Failed to get request verification token: ${response.statusText}`);
		}

		/* Converting login page response to JSON to get token */
		let res: { data: { token: string } };
		try {
			res = await response.json() as { data: { token: string } };
		} catch {
			throw new Error('Failed to get request verification token: Invalid JSON response');
		}

		return res.data.token;
	}

	private async getScWebToken(requestVerificationToken: string): Promise<string>{
		/* Checking if there is a valid config */
		if(!this.config)
			throw new Error(`Failed to get ScWebToken: Need a valid config`);

		/* Grab a ScWebToken by log in */
		const options = {
			method: 'POST',
			headers: {
				'content-type': 'application/x-www-form-urlencoded',
				'Referer': 'https://webauth.southernco.com/SPA/OCC/login',
			},
			body: new URLSearchParams({
				Token: requestVerificationToken,
				ReturnUrl: 'none'
			})
		};

		const response = await fetch('https://webauth.southernco.com/SPA/Navigation', options);

		/* Checking for unsuccessful login */
		if(response.status !== 200){
			throw new Error(`Failed to get ScWebToken: ${response.statusText}`);
		}

		const res = await response.text();

		/* Regex to match token in response */
		const matchRegex = /name="ScWebToken" value="([^"]+\.[^"]+\.[^"]+)"/mi;

		/* Matching response's form to get ScWebToken */
		const data = matchRegex.exec(res);
		const ScWebToken = data !== null ? data[1] : null;

		if(ScWebToken === null || ScWebToken === undefined)
			throw new Error(`Could not find ScWebToken in response`);

		/* Returning ScWebToken */
		return ScWebToken;
	}

	private async getJwt(ScWebToken: string): Promise<string>{
		/* Trading ScWebToken for Jwt */
		const swtoptions = {
			method: 'POST',
			headers: {
				'content-type': 'application/x-www-form-urlencoded',
				'Referer': 'https://webauth.southernco.com/'
			},
			body: new URLSearchParams({
				ScWebToken: ScWebToken,
			}),
			redirect: "manual" as RequestRedirect
		};

		const swtresponse = await fetch('https://customerservice2.southerncompany.com/Account/LoginComplete?ReturnUrl=/Billing/Home', swtoptions);

		/* Checking for unsuccessful login */
		if(swtresponse.status !== 302){
			throw new Error(`Failed to get secondary ScWebToken: ${swtresponse.statusText}`);
		}
		/* Regex to parse JWT out of headers */
		const swtregex = /SouthernJwtCookie=([^;]+);/i;

		/* Parsing response header to get token */
		let swtoken: string;
		let swtcookies = swtresponse.headers.get('set-cookie');

		if(swtcookies){
			const swtmatches = swtcookies.match(swtregex);

			/* Checking for matches */
			if(swtmatches && swtmatches.length > 1){
				swtoken = swtmatches[1];
			}
			else{
				throw new Error(`Failed to get secondary ScWebToken: Could not find any token matches in headers`);
			}
		}
		else{
			throw new Error(`Failed to get secondary ScWebToken: No Cookies were sent back`);
		}

		// Now fetch JWT after secondary ScWebToken
		const options = {
			headers:{
				Cookie: `SouthernJwtCookie=${swtoken}`
			}
		};

		const response = await fetch('https://customerservice2.southerncompany.com/Account/LoginValidated/JwtToken', options);

		if(response.status !== 200){
			throw new Error(`Failed to get JWT: ${response.statusText}`);
		}

		/* Regex to parse JWT out of headers */
		const regex = /ScJwtToken=([^;]+);/i;

		/* Parsing response header to get token */
		let token: string;
		let cookies = response.headers.get('set-cookie');

		if(cookies){
			const matches = cookies.match(regex);

			/* Checking for matches */
			if(matches && matches.length > 1){
				token = matches[1];
			}
			else{
				throw new Error(`Failed to get JWT: Could not find any token matches in headers`);
			}
		}
		else{
			throw new Error(`Failed to get JWT: No Cookies were sent back`);
		}

		/* Returning JWT */
		return token;
	}

	/* Public API methods */
	public async login(config?: SouthernCompanyConfig){

		// Save config if one is passed in
		if(config){
			this.config = config;
		}

		// Checking if we have a config to log in with
		if(!this.config){
			throw new Error('Could not login: No config avaliable');
		}

		/* Request Verification Token */
		const loginToken = await this.getRequestVerificationToken(this.config.username, this.config.password);

		/* ScWebToken */
		const ScWebToken = await this.getScWebToken(loginToken);

		/* Saving JWT */
		this.jwt = await this.getJwt(ScWebToken);

		/* Getting accounts if none are supplied */
		this.accounts = await this.getAccounts();

		/* Returning */
		return this.getConfigAccounts();
	}

	public async getAccounts(jwt?: string){

		// If no jwt is passed in, login
		if(!jwt && !this.jwt){
			await this.login(this.config)
		}

		/* Checking to make sure we have a JWT to use */
		if(!this.jwt){
			throw new Error('Could not get accounts: Not Logged In');
		}

		/* Grabbing accounts from API */
		const options = {
			headers: {
				Authorization: `bearer ${this.jwt}`
			}
		};
		const response = await fetch('https://customerservice2api.southerncompany.com/api/account/getAllAccounts', options);

		/* Checking for unsuccessful api call */
		if(response.status !== 200){
			throw new Error(`Failed to get accounts: ${response.statusText}`);
		}

		/* Parsing response */
		let resData: GetAllAccountsResponse;
		try {
			resData = await response.json() as GetAllAccountsResponse;
		} catch {
			throw new Error('Failed to get accounts: Invalid JSON response');
		}

		/* Parsing accounts from response */
		let accounts: Account[] = resData.Data.map((account)=>{
			const companyName = Company[account.Company];
			if(companyName === undefined){
				throw new Error(`Unknown company value: ${account.Company}`);
			}
			return {
				name: account.Description,
				primary: account.PrimaryAccount,
				number: account.AccountNumber,
				company: companyName
			};
		});

		/* Filtering accounts if needed */
		if(this.config?.account || this.config?.accounts){
			/* Creating accounts array to compare against */
			const accountsFilter = this.config.accounts ?? [];
			if(this.config.account){
				/* If only one account then place it in the array */
				accountsFilter.push(this.config.account);
			}

			/* Filtering accounts */
			accounts = accounts.filter((account)=> accountsFilter.includes(account.number.toString()));
		}

		/* Returning accounts */
		return accounts;
	}

	/* Data methods */
	public async getMonthlyData(jwt?: string){

		// If no jwt is passed in, login
		if(!jwt){
			await this.login(this.config)
		}

		/* Checking to make sure we have a JWT to use */
		if(!this.jwt){
			throw new Error('Could not get monthly data: Not Logged In');
		}

		/* Calculating which accounts to fetch data from */
		const accounts = this.getConfigAccounts();

		/* Creating a request for each account */
		const requests = accounts.map((account)=>{
			return fetch(`https://customerservice2api.southerncompany.com/api/MyPowerUsage/MPUData/${account.number}/Monthly?OPCO=${account.company}`, {
				method: 'GET',
				headers: {
					Authorization: `bearer ${this.jwt}`
				}
			});
		});

		/* Waiting for all requests (using allSettled for resilience) */
		const results = await Promise.allSettled(requests);

		/* Filter to only fulfilled responses and convert to JSON */
		const responses: MonthlyDataResponse[] = [];
		for(const result of results){
			if(result.status === 'rejected') continue;
			const response = result.value;
			if(!response.ok) continue;
			try {
				const data = await response.json() as MonthlyDataResponse;
				responses.push(data);
			} catch {
				continue;
			}
		}

		/* Grabbing data from all responses */
		const monthlyData = responses.filter(response => {
			const parsed = this.safeJsonParse(response.Data.Data);
			return parsed !== null;
		}).map((response)=> {
			/* Parsing graph data */
			const chartData = this.safeJsonParse(response.Data.Data) as {
				series: {
					usage: { data: { startDate: string; endDate: string; y: number }[] };
					cost: { data: { y: number }[] };
				};
			};

			if(!chartData) return [];

			const usageData = chartData.series.usage.data;
			const costData = chartData.series.cost.data;

			return usageData.map((d, i) => ({
				startDate: parseISO(d.startDate),
				endDate: parseISO(d.endDate),
				kWh: d.y,
				cost: i < costData.length ? costData[i].y : undefined
			}));
		});

		/* Returning monthly data */
		return monthlyData;
	}

	/* Get service points (meters) for an account */
	public async getServicePoints(accountNumber: number, company: string, jwt?: string): Promise<ServicePoint[]> {
		await this.ensureLoggedIn(jwt);

		const response = await fetch(
			`https://customerservice2api.southerncompany.com/api/MyPowerUsage/getMPUBasicAccountInformation/${accountNumber}/${company}`,
			{
				method: 'GET',
				headers: {
					Authorization: `bearer ${this.jwt}`
				}
			}
		);

		if(!response.ok){
			throw new Error(`Failed to get service points for account ${accountNumber}: ${response.statusText}`);
		}

		let resData: ServicePointResponse;
		try {
			resData = await response.json() as ServicePointResponse;
		} catch {
			throw new Error(`Failed to get service points for account ${accountNumber}: Invalid JSON response`);
		}

		return resData.Data.meterAndServicePoints;
	}

	/* Get daily usage data for all configured accounts */
	public async getDailyData(startDate: Date, endDate: Date, jwt?: string): Promise<DailyData[]> {
		await this.ensureLoggedIn(jwt);

		const accounts = this.getConfigAccounts();
		const startParam = this.formatDateParam(startDate);
		const endParam = this.formatDateParam(endDate);

		const results: DailyData[] = [];

		for(const account of accounts){
			/* Get service points for this account */
			let servicePoints: ServicePoint[];
			try {
				servicePoints = await this.getServicePoints(account.number, account.company);
			} catch {
				continue;
			}

			if(servicePoints.length === 0) continue;

			/* Fetch daily data for each service point */
			const requests = servicePoints.map(sp =>
				fetch(
					`https://customerservice2api.southerncompany.com/api/MyPowerUsage/MPUData/${account.number}/Daily?OPCO=${account.company}&StartDate=${encodeURIComponent(startParam)}&EndDate=${encodeURIComponent(endParam)}&intervalBehavior=Automatic&ServicePointNumber=${sp.servicePointNumber}`,
					{
						method: 'GET',
						headers: {
							Authorization: `bearer ${this.jwt}`
						}
					}
				)
			);

			const responses = await Promise.allSettled(requests);

			for(const result of responses){
				if(result.status === 'rejected') continue;
				const response = result.value;
				if(!response.ok) continue;

				let resData: DailyDataResponse;
				try {
					resData = await response.json() as DailyDataResponse;
				} catch {
					continue;
				}

				if(!resData.Data?.Data) continue;

				const chartData = this.safeJsonParse(resData.Data.Data) as {
					series: {
						weekdayUsage?: { data: { x: number; y: number; name: string }[] };
						weekendUsage?: { data: { x: number; y: number; name: string }[] };
						weekdayCost?: { data: { x: number; y: number; name: string }[] };
						weekendCost?: { data: { x: number; y: number; name: string }[] };
					};
				} | null;

				if(!chartData) continue;

				/* Merge weekday and weekend series into a single sorted array */
				const usageEntries: { x: number; y: number; name: string }[] = [
					...(chartData.series.weekdayUsage?.data ?? []),
					...(chartData.series.weekendUsage?.data ?? [])
				].sort((a, b) => a.x - b.x);

				const costEntries: { x: number; y: number; name: string }[] = [
					...(chartData.series.weekdayCost?.data ?? []),
					...(chartData.series.weekendCost?.data ?? [])
				].sort((a, b) => a.x - b.x);

				/* Build a cost lookup by x index for safe matching */
				const costByIndex = new Map<number, number>();
				for(const c of costEntries){
					costByIndex.set(c.x, c.y);
				}

				const data = usageEntries.map(d => ({
					date: parseISO(d.name),
					kWh: d.y,
					cost: costByIndex.get(d.x) ?? null
				}));

				results.push({
					accountNumber: account.number.toString(),
					data
				});
			}
		}

		return results;
	}

	/* Get hourly usage data for all configured accounts */
	public async getHourlyData(startDate: Date, endDate: Date, jwt?: string): Promise<AccountHourlyData[]> {
		await this.ensureLoggedIn(jwt);

		const accounts = this.getConfigAccounts();
		const startParam = this.formatDateParam(startDate);
		const endParam = this.formatDateParam(endDate);

		const results: AccountHourlyData[] = [];

		for(const account of accounts){
			/* Get service points for this account */
			let servicePoints: ServicePoint[];
			try {
				servicePoints = await this.getServicePoints(account.number, account.company);
			} catch {
				continue;
			}

			if(servicePoints.length === 0) continue;

			/* Fetch hourly data for each service point */
			const requests = servicePoints.map(sp =>
				fetch(
					`https://customerservice2api.southerncompany.com/api/MyPowerUsage/MPUData/${account.number}/Hourly?OPCO=${account.company}&StartDate=${encodeURIComponent(startParam)}&EndDate=${encodeURIComponent(endParam)}&intervalBehavior=Automatic&ServicePointNumber=${sp.servicePointNumber}`,
					{
						method: 'GET',
						headers: {
							Authorization: `bearer ${this.jwt}`
						}
					}
				)
			);

			const responses = await Promise.allSettled(requests);

			for(const result of responses){
				if(result.status === 'rejected') continue;
				const response = result.value;
				if(!response.ok) continue;

				let resData: HourlyDataResponse;
				try {
					resData = await response.json() as HourlyDataResponse;
				} catch {
					continue;
				}

				if(!resData.Data?.Data) continue;

				const chartData = this.safeJsonParse(resData.Data.Data) as {
					series: {
						usage: { data: { x: number; y: number; name: string; resolution: string }[] };
						cost: { data: { x: number; y: number; name: string; resolution: string }[] };
						temp: { data: { x: number; y: number; name: string; resolution: string }[] };
					};
				} | null;

				if(!chartData) continue;

				const usageData = chartData.series.usage.data;
				const costData = chartData.series.cost.data;
				const tempData = chartData.series.temp.data;

				/* Build lookups by x index for safe matching */
				const costByIndex = new Map<number, number>();
				for(const c of costData){
					costByIndex.set(c.x, c.y);
				}
				const tempByIndex = new Map<number, number>();
				for(const t of tempData){
					tempByIndex.set(t.x, t.y);
				}

				const data: HourlyData[] = usageData.map(d => ({
					date: parseISO(d.name),
					kWh: d.y,
					cost: costByIndex.get(d.x) ?? null,
					tempF: tempByIndex.get(d.x) ?? 0
				}));

				results.push({
					accountNumber: account.number,
					data
				});
			}
		}

		return results;
	}
}