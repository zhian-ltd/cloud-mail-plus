import app from '../hono/hono';
import userService from '../service/user-service';
import result from '../model/result';
import userContext from '../security/user-context';
import userPushSettingService from '../service/user-push-setting-service';

app.get('/my/loginUserInfo', async (c) => {
	const user = await userService.loginUserInfo(c, userContext.getUserId(c));
	return c.json(result.ok(user));
});

app.put('/my/resetPassword', async (c) => {
	await userService.resetPassword(c, await c.req.json(), userContext.getUserId(c));
	return c.json(result.ok());
});

app.delete('/my/delete', async (c) => {
	await userService.delete(c, userContext.getUserId(c));
	return c.json(result.ok());
});

app.get('/my/pushSetting', async (c) => {
	const setting = await userPushSettingService.get(c, userContext.getUserId(c));
	return c.json(result.ok(setting));
});

app.put('/my/pushSetting', async (c) => {
	const setting = await userPushSettingService.set(c, await c.req.json(), userContext.getUserId(c));
	return c.json(result.ok(setting));
});

