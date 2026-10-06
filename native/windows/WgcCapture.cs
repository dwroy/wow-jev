// Inbox WinRT + a minimal D3D11 interop surface. No SharpDX/NuGet/SDK install.
// HWND interop and free-threaded frame pools follow Microsoft Win32 capture APIs.
using System;
using System.Collections.Generic;
using System.Drawing;
using System.Drawing.Imaging;
using System.Runtime.InteropServices;
using System.Runtime.InteropServices.WindowsRuntime;
using System.Threading;
using Windows.Graphics;
using Windows.Graphics.Capture;
using Windows.Graphics.DirectX;
using Windows.Graphics.DirectX.Direct3D11;
using WowJev.Input;

sealed class WgcCapture : IDisposable
{
    [ComImport,Guid("3628E81B-3CAC-4C60-B7F4-23CE0E0C3356"),InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface ItemInterop {IntPtr CreateForWindow(IntPtr hwnd,ref Guid iid);IntPtr CreateForMonitor(IntPtr monitor,ref Guid iid);}
    [ComImport,Guid("A9B3D012-3DF2-4EE3-B8D1-8695F457D3C1"),InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface DxgiAccess {[PreserveSig]int GetInterface(ref Guid iid,out IntPtr value);}
    [StructLayout(LayoutKind.Sequential)] struct TextureDescription {public uint Width,Height,MipLevels,ArraySize,Format,SampleCount,SampleQuality,Usage,BindFlags,CpuAccessFlags,MiscFlags;}
    [StructLayout(LayoutKind.Sequential)] struct Box {public uint Left,Top,Front,Right,Bottom,Back;}
    [StructLayout(LayoutKind.Sequential)] struct Mapped {public IntPtr Data;public uint RowPitch,DepthPitch;}
    [UnmanagedFunctionPointer(CallingConvention.StdCall)] delegate int CreateTexture(IntPtr self,ref TextureDescription desc,IntPtr initial,out IntPtr texture);
    [UnmanagedFunctionPointer(CallingConvention.StdCall)] delegate void TextureDesc(IntPtr self,out TextureDescription desc);
    [UnmanagedFunctionPointer(CallingConvention.StdCall)] delegate void CopyRegion(IntPtr self,IntPtr destination,uint destinationSubresource,uint x,uint y,uint z,IntPtr source,uint sourceSubresource,ref Box box);
    [UnmanagedFunctionPointer(CallingConvention.StdCall)] delegate int MapResource(IntPtr self,IntPtr resource,uint subresource,uint type,uint flags,out Mapped result);
    [UnmanagedFunctionPointer(CallingConvention.StdCall)] delegate void UnmapResource(IntPtr self,IntPtr resource,uint subresource);
    [DllImport("d3d11.dll")] static extern int D3D11CreateDevice(IntPtr adapter,uint driver,IntPtr software,uint flags,IntPtr levels,uint levelCount,uint sdk,out IntPtr device,out uint level,out IntPtr context);
    [DllImport("d3d11.dll")] static extern int CreateDirect3D11DeviceFromDXGIDevice(IntPtr dxgi,out IntPtr inspectable);
    static readonly Guid CaptureGuid=new Guid("79C3F95B-31F7-4EC2-A464-632EF5D30760");
    static readonly Guid DxgiDeviceGuid=new Guid("54EC77FA-1377-44E6-8C32-88FD5F44C84C");
    static readonly Guid TextureGuid=new Guid("6F15AAF2-D208-4E89-9AB4-489535D34F9C");
    readonly object sync=new object();readonly AutoResetEvent wake=new AutoResetEvent(false);
    readonly Dictionary<string,IntPtr> staging=new Dictionary<string,IntPtr>();
    IntPtr device,context;IDirect3DDevice projected;GraphicsCaptureItem item;Direct3D11CaptureFramePool pool;GraphicsCaptureSession session;
    Direct3D11CaptureFrame latest;double latestArrived,lastSource,lastArrival,lastRequest;long onFrameCalls,framesReceived,staleDiscarded;int lastWidth,lastHeight;string callbackError;bool disposed,closed;SizeInt32 poolSize;
    CreateTexture createTexture;CopyRegion copy;MapResource map;UnmapResource unmap;
    public WgcCapture(IntPtr hwnd){
        try{
            ResidentWire.Need(GraphicsCaptureSession.IsSupported(),"wgc_unsupported");
            uint level;int hr=D3D11CreateDevice(IntPtr.Zero,1,IntPtr.Zero,0x20,IntPtr.Zero,0,7,out device,out level,out context);
            ResidentWire.Need(hr>=0,"d3d11_device_unavailable");
            IntPtr dxgi=IntPtr.Zero,winrt=IntPtr.Zero;try{
                Guid guid=DxgiDeviceGuid;Marshal.ThrowExceptionForHR(Marshal.QueryInterface(device,ref guid,out dxgi));
                Marshal.ThrowExceptionForHR(CreateDirect3D11DeviceFromDXGIDevice(dxgi,out winrt));projected=(IDirect3DDevice)Marshal.GetObjectForIUnknown(winrt);
            }finally{if(winrt!=IntPtr.Zero)Marshal.Release(winrt);if(dxgi!=IntPtr.Zero)Marshal.Release(dxgi);}
            var factory=(ItemInterop)WindowsRuntimeMarshal.GetActivationFactory(typeof(GraphicsCaptureItem));Guid capture=CaptureGuid;IntPtr pointer=factory.CreateForWindow(hwnd,ref capture);
            try{item=(GraphicsCaptureItem)Marshal.GetObjectForIUnknown(pointer);}finally{Marshal.Release(pointer);}
            poolSize=item.Size;ResidentWire.Need(poolSize.Width>0&&poolSize.Height>0,"wgc_empty_item");
            pool=Direct3D11CaptureFramePool.CreateFreeThreaded(projected,DirectXPixelFormat.B8G8R8A8UIntNormalized,3,poolSize);
            pool.FrameArrived+=OnFrame;item.Closed+=OnClosed;session=pool.CreateCaptureSession(item);
            createTexture=Method<CreateTexture>(device,5);copy=Method<CopyRegion>(context,46);map=Method<MapResource>(context,14);unmap=Method<UnmapResource>(context,15);
            session.StartCapture();
        }catch{Dispose();throw;}
    }
    static T Method<T>(IntPtr pointer,int slot)where T:class {IntPtr table=Marshal.ReadIntPtr(pointer),function=Marshal.ReadIntPtr(table,slot*IntPtr.Size);return Marshal.GetDelegateForFunctionPointer(function,typeof(T))as T;}
    void OnClosed(GraphicsCaptureItem sender,object unused){lock(sync)closed=true;wake.Set();}
    void OnFrame(Direct3D11CaptureFramePool sender,object unused){
        Interlocked.Increment(ref onFrameCalls);
        try{Direct3D11CaptureFrame frame;while((frame=sender.TryGetNextFrame())!=null){
            double arrived=Clock.PreciseMs;lock(sync){framesReceived++;lastSource=frame.SystemRelativeTime.TotalMilliseconds;lastArrival=arrived;lastWidth=frame.ContentSize.Width;lastHeight=frame.ContentSize.Height;if(disposed){frame.Dispose();return;}if(latest!=null)latest.Dispose();latest=frame;latestArrived=arrived;}wake.Set();
        }}catch(Exception error){lock(sync){closed=true;callbackError=error.GetType().Name+":"+error.HResult;}try{wake.Set();}catch(ObjectDisposedException){}}
    }
    public Dictionary<string,object> Diagnostic(double request=0){lock(sync)return ResidentWire.Obj("on_frame_calls",Interlocked.Read(ref onFrameCalls),"frames_received",framesReceived,"stale_frames_discarded",staleDiscarded,"last_content_width",lastWidth,"last_content_height",lastHeight,"last_system_relative_time_qpc_ms",lastSource,"last_frame_arrived_qpc_ms",lastArrival,"request_qpc_ms",request==0?lastRequest:request,"latest_frame_present",latest!=null,"closed",closed,"disposed",disposed,"callback_error",callbackError,"caller_apartment",Thread.CurrentThread.GetApartmentState().ToString(),"source_clock_policy","frame_system_relative_time_must_be_at_or_after_request");}
    public Snapshot Fresh(double requestedMs,int timeoutMs,Func<bool> stop,IntPtr hwnd,Dictionary<string,object> window){
        lock(sync)lastRequest=requestedMs;
        double deadline=Clock.PreciseMs+timeoutMs;
        while(Clock.PreciseMs<deadline){
            ResidentWire.Need(!stop(),"cancelled");Direct3D11CaptureFrame frame=null;double arrived=0;
            lock(sync){ResidentWire.Need(!closed&&!disposed,"wgc_closed");if(latest!=null){frame=latest;arrived=latestArrived;latest=null;}}
            if(frame!=null){
                if(frame.ContentSize.Width!=poolSize.Width||frame.ContentSize.Height!=poolSize.Height){
                    SizeInt32 resize=frame.ContentSize;frame.Dispose();ResidentWire.Need(resize.Width>0&&resize.Height>0,"wgc_empty_resize");
                    lock(sync){if(latest!=null){latest.Dispose();latest=null;}poolSize=resize;pool.Recreate(projected,DirectXPixelFormat.B8G8R8A8UIntNormalized,3,poolSize);}
                    continue;
                }
                double source=frame.SystemRelativeTime.TotalMilliseconds;
                if(source>=requestedMs&&source<=arrived&&source>=0){try{return new Snapshot(this,frame,source,arrived,hwnd,window,stop);}catch{frame.Dispose();throw;}}
                lock(sync)staleDiscarded++;frame.Dispose();
            }
            wake.WaitOne(5);
        }
        throw new InvalidOperationException("fresh_wgc_frame_timeout");
    }
    public sealed class Roi : IDisposable {public Rectangle Rectangle;public Bitmap Bitmap;public byte[] Pixels;public string Hash;public void Dispose(){if(Bitmap!=null)Bitmap.Dispose();}}
    public sealed class Snapshot : IDisposable {
        readonly WgcCapture owner;readonly Func<bool> stop;Direct3D11CaptureFrame frame;IntPtr texture;readonly int xOffset,yOffset,width,height;readonly TextureDescription description;
        public readonly double SourceMs,ArrivedMs;public readonly string ClientMapping;
        public Snapshot(WgcCapture owner,Direct3D11CaptureFrame frame,double source,double arrived,IntPtr hwnd,Dictionary<string,object> window,Func<bool> stop){
            try{
            this.owner=owner;this.stop=stop;this.frame=frame;SourceMs=source;ArrivedMs=arrived;width=ResidentWire.Int(window,"client_width");height=ResidentWire.Int(window,"client_height");
            var surface=(DxgiAccess)frame.Surface;Guid guid=TextureGuid;Marshal.ThrowExceptionForHR(surface.GetInterface(ref guid,out texture));
            Method<TextureDesc>(texture,10)(texture,out description);
            ResidentWire.Need(description.Format==87&&description.SampleCount==1,"wgc_surface_format_unsupported");
            if(frame.ContentSize.Width==width&&frame.ContentSize.Height==height){xOffset=0;yOffset=0;ClientMapping="exact_client_content_size";}
            else{
                var bounds=ResidentIdentity.FrameBounds(hwnd);var client=ResidentWire.Map(window["client_rect"]);
                ResidentWire.Need(frame.ContentSize.Width==bounds.Right-bounds.Left&&frame.ContentSize.Height==bounds.Bottom-bounds.Top,"wgc_client_mapping_unknown");
                xOffset=ResidentWire.Int(client,"left")-bounds.Left;yOffset=ResidentWire.Int(client,"top")-bounds.Top;ClientMapping="dwm_extended_frame_bounds";
            }
            ResidentWire.Need(xOffset>=0&&yOffset>=0&&xOffset+width<=frame.ContentSize.Width&&yOffset+height<=frame.ContentSize.Height&&frame.ContentSize.Width<=description.Width&&frame.ContentSize.Height<=description.Height,"wgc_client_outside_surface");
            }catch{if(texture!=IntPtr.Zero){Marshal.Release(texture);texture=IntPtr.Zero;}throw;}
        }
        public Roi Read(Rectangle rect){
            ResidentWire.Need(rect.X>=0&&rect.Y>=0&&rect.Width>0&&rect.Height>0&&rect.Right<=width&&rect.Bottom<=height,"wgc_roi_bounds");
            string key=rect.Width+"x"+rect.Height;IntPtr staging;
            if(!owner.staging.TryGetValue(key,out staging)){
                var desc=new TextureDescription{Width=(uint)rect.Width,Height=(uint)rect.Height,MipLevels=1,ArraySize=1,Format=87,SampleCount=1,Usage=3,CpuAccessFlags=0x20000};
                Marshal.ThrowExceptionForHR(owner.createTexture(owner.device,ref desc,IntPtr.Zero,out staging));owner.staging.Add(key,staging);
            }
            var box=new Box{Left=(uint)(rect.X+xOffset),Top=(uint)(rect.Y+yOffset),Front=0,Right=(uint)(rect.Right+xOffset),Bottom=(uint)(rect.Bottom+yOffset),Back=1};
            ResidentWire.Need(!stop(),"cancelled");owner.copy(owner.context,staging,0,0,0,0,texture,0,ref box);Mapped mapped;double deadline=Clock.PreciseMs+100;
            while(true){ResidentWire.Need(!stop(),"cancelled");int result=owner.map(owner.context,staging,0,1,0x100000,out mapped);if(result>=0)break;
                ResidentWire.Need(result==unchecked((int)0x887a000a),"wgc_map_failed:"+result.ToString("x"));ResidentWire.Need(Clock.PreciseMs<deadline,"wgc_roi_map_timeout");Thread.Sleep(1);
            }
            var bytes=new byte[checked(rect.Width*rect.Height*4)];try{
                ResidentWire.Need(mapped.Data!=IntPtr.Zero&&mapped.RowPitch>=(uint)(rect.Width*4),"wgc_map_pitch");
                for(int y=0;y<rect.Height;y++)Marshal.Copy(IntPtr.Add(mapped.Data,checked((int)mapped.RowPitch*y)),bytes,y*rect.Width*4,rect.Width*4);
            }finally{owner.unmap(owner.context,staging,0);}
            // Evidence hashes and ROI hashes use explicit opaque, top-down BGRA.
            // Alpha is compositor bookkeeping, not a scene classifier.
            for(int i=3;i<bytes.Length;i+=4)bytes[i]=255;
            var bitmap=new Bitmap(rect.Width,rect.Height,PixelFormat.Format32bppArgb);
            try{var locked=bitmap.LockBits(new Rectangle(0,0,rect.Width,rect.Height),ImageLockMode.WriteOnly,PixelFormat.Format32bppArgb);
                try{for(int y=0;y<rect.Height;y++)Marshal.Copy(bytes,y*rect.Width*4,IntPtr.Add(locked.Scan0,y*locked.Stride),rect.Width*4);}finally{bitmap.UnlockBits(locked);}
                return new Roi{Rectangle=rect,Bitmap=bitmap,Pixels=bytes,Hash=ResidentWire.Hash(bytes)};
            }catch{bitmap.Dispose();throw;}
        }
        public void Dispose(){if(texture!=IntPtr.Zero){Marshal.Release(texture);texture=IntPtr.Zero;}if(frame!=null){frame.Dispose();frame=null;}}
    }
    public void Dispose(){
        lock(sync){if(disposed)return;disposed=true;closed=true;if(latest!=null){latest.Dispose();latest=null;}}
        if(session!=null){session.Dispose();session=null;}if(pool!=null){pool.FrameArrived-=OnFrame;pool.Dispose();pool=null;}if(item!=null){item.Closed-=OnClosed;item=null;}
        foreach(var pointer in staging.Values)Marshal.Release(pointer);staging.Clear();if(projected!=null){projected.Dispose();projected=null;}
        if(context!=IntPtr.Zero){Marshal.Release(context);context=IntPtr.Zero;}if(device!=IntPtr.Zero){Marshal.Release(device);device=IntPtr.Zero;}wake.Dispose();
    }
}
