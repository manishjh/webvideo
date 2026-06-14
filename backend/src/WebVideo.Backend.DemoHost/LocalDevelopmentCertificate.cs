using System.Net;
using System.Security.Cryptography;
using System.Security.Cryptography.X509Certificates;

namespace WebVideo.Backend.DemoHost;

public static class LocalDevelopmentCertificate
{
    public static X509Certificate2 LoadOrCreate(string path, string password)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(path);
        ArgumentException.ThrowIfNullOrWhiteSpace(password);

        if (File.Exists(path))
        {
            var existing = X509CertificateLoader.LoadPkcs12FromFile(path, password);
            if (IsUsableForWebTransport(existing))
            {
                return existing;
            }

            existing.Dispose();
        }

        var directory = Path.GetDirectoryName(path);
        if (!string.IsNullOrWhiteSpace(directory))
        {
            Directory.CreateDirectory(directory);
        }

        using var ecdsa = ECDsa.Create(ECCurve.NamedCurves.nistP256);
        var request = new CertificateRequest(
            "CN=127.0.0.1",
            ecdsa,
            HashAlgorithmName.SHA256);

        var subjectAlternativeNames = new SubjectAlternativeNameBuilder();
        subjectAlternativeNames.AddDnsName("localhost");
        subjectAlternativeNames.AddIpAddress(IPAddress.Loopback);
        request.CertificateExtensions.Add(subjectAlternativeNames.Build());
        request.CertificateExtensions.Add(new X509BasicConstraintsExtension(false, false, 0, false));
        request.CertificateExtensions.Add(new X509KeyUsageExtension(X509KeyUsageFlags.DigitalSignature, false));
        request.CertificateExtensions.Add(new X509EnhancedKeyUsageExtension(
            [new Oid("1.3.6.1.5.5.7.3.1")],
            false));

        var notBefore = DateTimeOffset.UtcNow.AddMinutes(-5);
        var notAfter = notBefore.AddDays(13);
        using var certificate = request.CreateSelfSigned(notBefore, notAfter);
        var export = certificate.Export(X509ContentType.Pkcs12, password);
        File.WriteAllBytes(path, export);

        return X509CertificateLoader.LoadPkcs12(export, password);
    }

    public static string CreateSha256HashBase64(X509Certificate2 certificate)
        => Convert.ToBase64String(SHA256.HashData(certificate.RawData));

    private static bool IsUsableForWebTransport(X509Certificate2 certificate)
    {
        var validityWindow = certificate.NotAfter.ToUniversalTime() - certificate.NotBefore.ToUniversalTime();
        using var ecdsa = certificate.GetECDsaPublicKey();
        return validityWindow <= TimeSpan.FromDays(14)
            && certificate.NotAfter.ToUniversalTime() > DateTime.UtcNow.AddDays(1)
            && ecdsa is not null;
    }
}
